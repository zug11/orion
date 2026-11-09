#![allow(dead_code)]
#[path = "../src-tauri/shared/assistant_protocol.rs"]
mod assistant_protocol;
#[path = "../src-tauri/shared/windows_ipc_identity.rs"]
mod windows_ipc_identity;
#[path = "../src-tauri/src/assistant_pipe.rs"]
mod assistant_pipe;
#[path = "windows_pipe_previous.rs"]
mod previous_pipe;

#[test]
fn compares_previous_and_current_descriptor_creation() {
    let directory = tempfile::tempdir().unwrap();
    let sid = assistant_pipe::current_account().unwrap();
    let descriptor = assistant_protocol::BridgeDescriptor {
        version: assistant_protocol::BRIDGE_VERSION,
        vault_path: directory.path().join("vault.json").to_string_lossy().into(),
        socket_path: format!("{}{}", assistant_protocol::WINDOWS_PIPE_PREFIX, "e".repeat(64)),
        token: "a".repeat(64),
    };
    println!("Previous descriptor creation returned: {:?}", previous_pipe::publish(directory.path(), &descriptor, &sid));
    assistant_pipe::publish(directory.path(), &descriptor, &sid).unwrap();
    println!("The current descriptor implementation published the file successfully.");
}

#[tokio::test]
async fn a_same_account_client_can_exchange_pipe_frames() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;
    use std::time::Duration;
    let sid = assistant_pipe::current_account().unwrap();
    let name = format!("{}{:064x}", assistant_protocol::WINDOWS_PIPE_PREFIX, std::process::id());
    let mut listener = assistant_pipe::listen(&name, &sid, true).unwrap();
    let mut client = ClientOptions::new().open(&name).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        listener.connect().await.unwrap();
        let next = assistant_pipe::listen(&name, &sid, false).unwrap();
        client.write_all(b"query").await.unwrap();
        let mut request = [0; 5];
        listener.read_exact(&mut request).await.unwrap();
        assert_eq!(&request, b"query");
        listener.write_all(b"reply").await.unwrap();
        let mut reply = [0; 5];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"reply");
        drop(next);
    }).await.unwrap();
}
