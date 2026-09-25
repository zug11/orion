//! Owned, cancellable subprocesses for local media imports. Audio never crosses IPC.
use std::{
    collections::HashMap,
    io::Read,
    process::{Child, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_JOBS: usize = 8;
const MAX_CANCELLATIONS: usize = 64;
const MAX_STDOUT: usize = 2 * 1024 * 1024;
const MAX_STDERR: usize = 256 * 1024;
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub(crate) const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Enforce the encoded-media file ceiling even when the remote server does not
/// report a size. The process and its descendants inherit the kernel limit.
pub(crate) fn limit_download_file_size(command: &mut Command, bytes: u64) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(move || {
                let limit = libc::rlimit {
                    rlim_cur: bytes as libc::rlim_t,
                    rlim_max: bytes as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (command, bytes);
    }
}

#[derive(Clone)]
pub(crate) struct Control {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    slot: Arc<Mutex<()>>,
    #[cfg(test)]
    forced_deadline: Arc<AtomicBool>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(90 * 60),
            slot: Arc::new(Mutex::new(())),
            #[cfg(test)]
            forced_deadline: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Control {
    pub(crate) fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("The media import was cancelled.".into());
        }
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        self.check_cancelled()?;
        let expired = Instant::now() >= self.deadline;
        #[cfg(test)]
        let expired = expired || self.forced_deadline.load(Ordering::Acquire);
        if expired {
            return Err(
                "The media import reached its 90-minute limit. Try a shorter recording.".into(),
            );
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn expire_for_test(&self) {
        self.forced_deadline.store(true, Ordering::Release);
    }

    pub(crate) fn run(&self, command: &mut Command, timeout: Duration) -> Result<Output, String> {
        self.check()?;
        let _slot = loop {
            self.check()?;
            match self.slot.try_lock() {
                Ok(slot) => break slot,
                Err(std::sync::TryLockError::Poisoned(error)) => break error.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        self.check()?;
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = OwnedChild {
            child: command.spawn().map_err(|error| {
                format!("Orion could not start its bundled media tool: {error}")
            })?,
            reaped: false,
        };
        let failed = Arc::new(AtomicBool::new(false));
        let stdout = read_pipe(
            child
                .child
                .stdout
                .take()
                .ok_or("The media tool has no output pipe.")?,
            MAX_STDOUT,
            failed.clone(),
        );
        let stderr = read_pipe(
            child
                .child
                .stderr
                .take()
                .ok_or("The media tool has no diagnostic pipe.")?,
            MAX_STDERR,
            failed.clone(),
        );
        let deadline = Instant::now() + timeout;
        let completion = (|| {
            loop {
                self.check()?;
                if Instant::now() >= deadline {
                    return Err("The media tool reached its time limit. Try a shorter recording or retry the download.".into());
                }
                if failed.load(Ordering::Acquire) {
                    return Err("The media tool exceeded its safe output limit or its output could not be read.".into());
                }
                if child.is_finished()? {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok::<(), String>(())
        })();
        // Terminate descendants before joining readers. An exited parent can
        // leave a descendant holding both pipes open indefinitely.
        let status = child.finish();
        let stdout = stdout
            .join()
            .map_err(|_| "The media output reader stopped unexpectedly.")?;
        let stderr = stderr
            .join()
            .map_err(|_| "The media diagnostic reader stopped unexpectedly.")?;
        completion?;
        let stdout = stdout?;
        let stderr = stderr?;
        self.check()?;
        Ok(Output {
            status: status?,
            stdout,
            stderr,
        })
    }
}

fn read_pipe(
    mut pipe: impl Read + Send + 'static,
    limit: usize,
    failed: Arc<AtomicBool>,
) -> std::thread::JoinHandle<Result<Vec<u8>, String>> {
    std::thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let count = match pipe.read(&mut buffer) {
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        return Err(format!("The media output could not be read: {error}"))
                    }
                };
                if count == 0 {
                    return Ok(bytes);
                }
                if count > limit - bytes.len() {
                    return Err("The media tool exceeded its safe output limit.".into());
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
        })();
        if result.is_err() {
            failed.store(true, Ordering::Release);
        }
        result
    })
}

struct OwnedChild {
    child: Child,
    reaped: bool,
}
impl OwnedChild {
    fn is_finished(&mut self) -> Result<bool, String> {
        #[cfg(unix)]
        {
            // WNOWAIT keeps the exact child's PID reserved even after it exits,
            // so its process group cannot be confused with a subsequently reused PID.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(false);
                }
                return Err(error.to_string());
            }
            Ok(unsafe { info.si_pid() } != 0)
        }
        #[cfg(not(unix))]
        {
            let done = self
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some();
            self.reaped = done;
            Ok(done)
        }
    }

    fn finish(&mut self) -> Result<std::process::ExitStatus, String> {
        if !self.reaped {
            #[cfg(unix)]
            {
                if let Ok(pid) = i32::try_from(self.child.id()) {
                    if pid > 1 {
                        unsafe {
                            libc::kill(-pid, libc::SIGKILL);
                        }
                    }
                }
            }
            #[cfg(not(unix))]
            {
                let _ = self.child.kill();
            }
        }
        let status = self.child.wait().map_err(|error| error.to_string());
        if status.is_ok() {
            self.reaped = true;
        }
        status
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[derive(Default)]
struct Registry {
    active: HashMap<(String, String), Control>,
    pending_pickers: HashMap<(String, String), Control>,
    cancelled: HashMap<(String, String), Instant>,
}

impl Registry {
    fn prune_cancellations(&mut self, now: Instant) {
        self.cancelled
            .retain(|_, at| now.saturating_duration_since(*at) < Duration::from_secs(120));
    }
}

#[derive(Clone, Default)]
pub(crate) struct MediaJobs {
    registry: Arc<Mutex<Registry>>,
    slot: Arc<Mutex<()>>,
    closing: Arc<AtomicBool>,
}

pub(crate) struct Job {
    pub(crate) control: Control,
    key: (String, String),
    registry: Arc<Mutex<Registry>>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    (8..=160).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

impl MediaJobs {
    pub(crate) fn begin(&self, owner: &str, id: &str) -> Result<Job, String> {
        self.register(owner, id, false)
    }

    pub(crate) fn begin_picker(&self, owner: &str, id: &str) -> Result<Job, String> {
        self.register(owner, id, true)
    }

    fn register(&self, owner: &str, id: &str, pending_picker: bool) -> Result<Job, String> {
        if !valid_id(id) {
            return Err("The media request identifier is invalid.".into());
        }
        let key = (owner.to_owned(), id.to_owned());
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.closing.load(Ordering::Acquire) {
            return Err("Orion is closing. Start the media import after reopening the app.".into());
        }
        registry.prune_cancellations(Instant::now());
        if registry.cancelled.remove(&key).is_some() {
            return Err("The media import was cancelled.".into());
        }
        if registry.active.contains_key(&key) || registry.pending_pickers.contains_key(&key) {
            return Err("That media import is already running.".into());
        }
        if registry.active.len() + registry.pending_pickers.len() >= MAX_JOBS {
            return Err(
                "Orion can queue up to eight media imports. Wait for one to finish.".into(),
            );
        }
        let control = Control {
            slot: self.slot.clone(),
            ..Control::default()
        };
        if pending_picker {
            registry
                .pending_pickers
                .insert(key.clone(), control.clone());
        } else {
            registry.active.insert(key.clone(), control.clone());
        }
        Ok(Job {
            control,
            key,
            registry: self.registry.clone(),
        })
    }

    pub(crate) fn promote_picker(&self, job: &Job) -> Result<(), String> {
        if !Arc::ptr_eq(&self.registry, &job.registry) {
            return Err("The media picker belongs to another host.".into());
        }
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.closing.load(Ordering::Acquire) {
            return Err("The media import was cancelled because Orion is closing.".into());
        }
        job.control.check()?;
        let pending = registry
            .pending_pickers
            .get(&job.key)
            .ok_or("This media picker is no longer active.")?;
        if !Arc::ptr_eq(&pending.cancelled, &job.control.cancelled) {
            return Err("The media picker request changed.".into());
        }
        let control = registry
            .pending_pickers
            .remove(&job.key)
            .ok_or("This media picker is no longer active.")?;
        registry.active.insert(job.key.clone(), control);
        Ok(())
    }

    pub(crate) fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("The media request identifier is invalid.".into());
        }
        let key = (owner.to_owned(), id.to_owned());
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(control) = registry
            .active
            .get(&key)
            .or_else(|| registry.pending_pickers.get(&key))
        {
            control.cancelled.store(true, Ordering::Release);
        } else {
            if registry
                .active
                .keys()
                .chain(registry.pending_pickers.keys())
                .any(|(other_owner, other_id)| other_id == id && other_owner != owner)
            {
                return Err("This media import belongs to another window.".into());
            }
            registry.prune_cancellations(Instant::now());
            if registry.cancelled.len() < MAX_CANCELLATIONS {
                registry.cancelled.insert(key, Instant::now());
            }
        }
        Ok(())
    }

    pub(crate) fn cancel_owner(&self, owner: &str) {
        let registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for ((candidate, _), control) in registry
            .active
            .iter()
            .chain(registry.pending_pickers.iter())
        {
            if candidate == owner {
                control.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn start_shutdown(&self) -> bool {
        let registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let first = !self.closing.swap(true, Ordering::AcqRel);
        for control in registry
            .active
            .values()
            .chain(registry.pending_pickers.values())
        {
            control.cancelled.store(true, Ordering::Release);
        }
        first
    }

    pub(crate) fn is_drained(&self) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .is_empty()
    }

    pub(crate) fn wait_until_drained(&self) {
        while !self.is_drained() {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        self.control.cancelled.store(true, Ordering::Release);
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.active.remove(&self.key);
        registry.pending_pickers.remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_owned_and_covers_start_races() {
        let jobs = MediaJobs::default();
        jobs.cancel("one", "request-before").unwrap();
        assert!(jobs.begin("one", "request-before").is_err());
        let job = jobs.begin("one", "request-active").unwrap();
        assert!(jobs.cancel("two", "request-active").is_err());
        assert!(job.control.check().is_ok());
        jobs.cancel("one", "request-active").unwrap();
        assert!(job.control.check().is_err());
        assert!(jobs.begin("one", "../bad").is_err());
    }

    #[test]
    fn shutdown_rejects_new_work_and_waits_for_owned_job_cleanup() {
        let jobs = MediaJobs::default();
        let job = jobs.begin("one", "request-shutdown").unwrap();
        assert!(jobs.start_shutdown());
        assert!(!jobs.start_shutdown());
        assert!(job.control.check().is_err());
        assert!(!jobs.is_drained());
        assert!(jobs.begin("one", "request-new-job").is_err());
        drop(job);
        assert!(jobs.is_drained());
    }

    #[test]
    fn picker_cancellation_outlives_race_tombstones_and_shutdown_never_waits_for_a_dialog() {
        let jobs = MediaJobs::default();
        let picker = jobs.begin_picker("one", "request-picker").unwrap();
        jobs.cancel("one", "request-picker").unwrap();
        jobs.registry
            .lock()
            .unwrap()
            .prune_cancellations(Instant::now() + Duration::from_secs(180));
        assert!(jobs
            .promote_picker(&picker)
            .unwrap_err()
            .contains("cancelled"));
        assert!(
            jobs.is_drained(),
            "A process-less picker must not block Quit"
        );
        assert!(jobs.start_shutdown());
        assert!(jobs.is_drained());
        assert!(jobs.promote_picker(&picker).is_err());
    }

    #[test]
    fn picker_promotion_registers_work_before_window_cancellation_or_shutdown() {
        let jobs = MediaJobs::default();
        let picker = jobs.begin_picker("one", "request-promoted").unwrap();
        assert!(jobs.is_drained());
        jobs.promote_picker(&picker).unwrap();
        assert!(!jobs.is_drained());
        jobs.cancel_owner("one");
        assert!(picker.control.check().is_err());
        drop(picker);
        assert!(jobs.is_drained());
    }
    #[cfg(unix)]
    #[test]
    fn running_children_are_cancelled_and_output_and_time_are_bounded() {
        let jobs = MediaJobs::default();
        let job = jobs.begin("one", "request-running").unwrap();
        let control = job.control.clone();
        let worker = std::thread::spawn(move || {
            control.run(
                Command::new("/bin/sh").args(["-c", "sleep 10"]),
                Duration::from_secs(20),
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        jobs.cancel("one", "request-running").unwrap();
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        let control = Control::default();
        assert!(control
            .run(
                Command::new("/bin/sh").args(["-c", "sleep 10"]),
                Duration::from_millis(100)
            )
            .unwrap_err()
            .contains("time limit"));
        assert!(control
            .run(
                Command::new("/bin/sh")
                    .args(["-c", "dd if=/dev/zero bs=1048576 count=3 2>/dev/null"]),
                Duration::from_secs(5)
            )
            .unwrap_err()
            .contains("output limit"));
    }

    #[cfg(unix)]
    #[test]
    fn exited_parent_cannot_leave_descendants_holding_pipes_open() {
        let started = Instant::now();
        let output = Control::default()
            .run(
                Command::new("/bin/sh").args(["-c", "sleep 10 & echo finished"]),
                Duration::from_secs(3),
            )
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "finished");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn pipe_read_failure_is_signalled_to_the_process_owner() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken"))
            }
        }
        let failed = Arc::new(AtomicBool::new(false));
        assert!(read_pipe(Broken, 10, failed.clone())
            .join()
            .unwrap()
            .is_err());
        assert!(failed.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn download_files_cannot_exceed_the_kernel_size_limit() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("bounded-media");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "dd if=/dev/zero bs=1024 count=8 of=\"$1\" 2>/dev/null",
            "test",
        ]);
        command.arg(&output);
        limit_download_file_size(&mut command, 4096);
        let result = Control::default()
            .run(&mut command, Duration::from_secs(5))
            .unwrap();
        assert!(!result.status.success());
        assert!(std::fs::metadata(output).unwrap().len() <= 4096);
    }
}
