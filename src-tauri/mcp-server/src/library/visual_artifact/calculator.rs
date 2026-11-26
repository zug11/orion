use super::{fields, index, invalid, list, literal, number};
use num_bigint::BigInt;
use serde_json::Value;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const EXHAUSTIVE_SETTINGS: usize = 256;

enum Binary {
    Add,
    Subtract,
    Multiply,
    Divide,
    Min,
    Max,
}

enum Expression {
    Constant(f64),
    Input(usize),
    Binary(Binary, Box<Expression>, Box<Expression>),
    Payment {
        principal: Box<Expression>,
        rate: Box<Expression>,
        periods: Box<Expression>,
    },
}

impl Expression {
    fn parse(
        value: &Value,
        inputs: usize,
        depth: usize,
        remaining: &mut usize,
    ) -> Result<Self, String> {
        if depth > 5 || *remaining == 0 {
            return Err(invalid(
                "Calculator formulas allow five levels and 63 nodes.",
            ));
        }
        *remaining -= 1;
        if value.is_number() {
            return number(value, -1e9, 1e9).map(Self::Constant);
        }
        if value.get("input").is_some() {
            fields(value, &["input"])?;
            return index(&value["input"], inputs).map(Self::Input);
        }

        let mut child =
            |key: &str| Self::parse(&value[key], inputs, depth + 1, remaining).map(Box::new);
        if value["op"] == "periodicPayment" {
            fields(value, &["op", "principal", "ratePerPeriod", "periods"])?;
            return Ok(Self::Payment {
                principal: child("principal")?,
                rate: child("ratePerPeriod")?,
                periods: child("periods")?,
            });
        }
        fields(value, &["op", "left", "right"])?;
        let op = match value["op"].as_str() {
            Some("add") => Binary::Add,
            Some("subtract") => Binary::Subtract,
            Some("multiply") => Binary::Multiply,
            Some("divide") => Binary::Divide,
            Some("min") => Binary::Min,
            Some("max") => Binary::Max,
            _ => return Err(invalid("Unknown calculator operation.")),
        };
        Ok(Self::Binary(op, child("left")?, child("right")?))
    }

    fn evaluate(&self, values: &[f64]) -> Option<f64> {
        let result = match self {
            Self::Constant(n) => *n,
            Self::Input(i) => values[*i],
            Self::Binary(op, left, right) => {
                let left = left.evaluate(values)?;
                let right = right.evaluate(values)?;
                match op {
                    Binary::Add => left + right,
                    Binary::Subtract => left - right,
                    Binary::Multiply => left * right,
                    Binary::Divide => left / right,
                    Binary::Min => left.min(right),
                    Binary::Max => left.max(right),
                }
            }
            Self::Payment {
                principal,
                rate,
                periods,
            } => {
                let principal = principal.evaluate(values)?;
                let rate = rate.evaluate(values)?;
                let periods = periods.evaluate(values)?;
                if principal < 0.0
                    || rate < 0.0
                    || !(1.0..=MAX_SAFE_INTEGER).contains(&periods)
                    || periods.fract() != 0.0
                {
                    return None;
                }
                if rate == 0.0 {
                    principal / periods
                } else {
                    let discount = -(-periods * rate.ln_1p()).exp_m1();
                    principal * (rate / discount)
                }
            }
        };
        result.is_finite().then_some(result)
    }
}

// Match the renderer's base-10 step grid, including decimal and scientific
// notation. The numerator may exceed machine integers even for finite f64s.
struct Grid {
    min: BigInt,
    step: BigInt,
    exponent: i32,
    last: BigInt,
    includes_zero: bool,
}

fn decimal(value: f64) -> (BigInt, i32) {
    let mut buffer = ryu_js::Buffer::new();
    let text = buffer.format_finite(value);
    let (coefficient, exponent) = match text.split_once('e') {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().expect("finite exponent")),
        None => (text, 0),
    };
    let (whole, fraction) = coefficient.split_once('.').unwrap_or((coefficient, ""));
    let digits = format!("{whole}{fraction}")
        .parse()
        .expect("finite decimal digits");
    (digits, exponent - fraction.len() as i32)
}

impl Grid {
    fn new(min: f64, max: f64, step: f64) -> Self {
        let decimals = [min, max, step].map(decimal);
        let exponent = decimals
            .iter()
            .map(|(_, exponent)| *exponent)
            .min()
            .unwrap();
        let [min, max, step] = decimals
            .map(|(digits, power)| digits * BigInt::from(10u8).pow((power - exponent) as u32));
        let zero = BigInt::from(0u8);
        let includes_zero = min < zero && max > zero && &min % &step == zero;
        let last = (max - &min) / &step;
        Self {
            min,
            step,
            exponent,
            last,
            includes_zero,
        }
    }

    fn value_at(&self, tick: &BigInt) -> f64 {
        let digits = &self.min + tick * &self.step;
        format!("{digits}e{}", self.exponent)
            .parse()
            .expect("bounded decimal slider value")
    }
}

struct Slider<'a> {
    label: &'a str,
    initial: f64,
    min: f64,
    grid: Grid,
}

impl<'a> Slider<'a> {
    fn parse(input: &'a Value) -> Result<Self, String> {
        fields(input, &["label", "unit", "min", "max", "step", "initial"])?;
        let label = literal(&input["label"], 100, false)?;
        literal(&input["unit"], 32, true)?;
        let min = number(&input["min"], -1e9, 1e9)?;
        let max = number(&input["max"], -1e9, 1e9)?;
        let step = number(&input["step"], -1e9, 1e9)?;
        if min >= max || step <= 0.0 || step > max - min || min + step == min {
            return Err(invalid(&format!(
                "Invalid slider bounds or step for “{label}”."
            )));
        }
        let initial = number(&input["initial"], min, max)?;
        let ticks = (initial - min) / step;
        if ticks.round() > MAX_SAFE_INTEGER || (ticks - ticks.round()).abs() > 1e-7 {
            return Err(invalid(&format!(
                "The default for “{label}” must align with its step."
            )));
        }
        Ok(Self {
            label,
            initial,
            min,
            grid: Grid::new(min, max, step),
        })
    }
}

fn visit_settings<F: Fn(&[f64]) -> Result<(), String>>(
    index: usize,
    samples: &[Vec<f64>],
    values: &mut [f64],
    check: &F,
) -> Result<(), String> {
    if index == samples.len() {
        return check(values);
    }
    for sample in &samples[index] {
        values[index] = *sample;
        visit_settings(index + 1, samples, values, check)?;
    }
    Ok(())
}

pub(super) fn validate(block: &Value) -> Result<(), String> {
    fields(block, &["kind", "inputs", "outputs"])?;
    let inputs = list(&block["inputs"], 1, 6)?
        .iter()
        .map(Slider::parse)
        .collect::<Result<Vec<_>, _>>()?;
    let mut outputs = Vec::new();
    for output in list(&block["outputs"], 1, 6)? {
        fields(output, &["label", "unit", "expression"])?;
        let label = literal(&output["label"], 100, false)?;
        literal(&output["unit"], 32, true)?;
        let expression = Expression::parse(&output["expression"], inputs.len(), 0, &mut 63)?;
        outputs.push((label, expression));
    }
    let check = |values: &[f64]| -> Result<(), String> {
        for (label, expression) in &outputs {
            if expression.evaluate(values).is_none() {
                let settings = inputs
                    .iter()
                    .zip(values)
                    .map(|(input, v)| {
                        format!(
                            "{} = {}",
                            input.label,
                            ryu_js::Buffer::new().format_finite(*v)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(invalid(&format!("“{label}” has no result at {settings}.")));
            }
        }
        Ok(())
    };

    let mut values: Vec<_> = inputs.iter().map(|input| input.initial).collect();
    check(&values)?;
    let exhaustive = inputs
        .iter()
        .try_fold(1usize, |count, input| {
            let last = usize::try_from(&input.grid.last).ok()?;
            count
                .checked_mul(last.checked_add(1)?)
                .filter(|n| *n <= EXHAUSTIVE_SETTINGS)
        })
        .is_some();
    let mut samples = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        if exhaustive {
            let last = usize::try_from(&input.grid.last).expect("bounded exhaustive grid");
            samples.push(
                (0..=last)
                    .map(|tick| input.grid.value_at(&BigInt::from(tick)))
                    .collect(),
            );
        } else {
            if input.grid.includes_zero {
                values[i] = 0.0;
                check(&values)?;
                values[i] = input.initial;
            }
            let mut endpoints = vec![
                input.min,
                input.initial,
                input.grid.value_at(&input.grid.last),
            ];
            endpoints.dedup(); // initial lies between the reachable endpoints when step-aligned.
            samples.push(endpoints);
        }
    }
    visit_settings(0, &samples, &mut values, &check)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn slider(label: &str, min: f64, max: f64, step: f64, initial: f64) -> Value {
        json!({"label":label, "unit":"%", "min":min, "max":max, "step":step, "initial":initial})
    }

    fn calculator(inputs: Vec<Value>, expression: Value) -> Value {
        json!({"kind":"calculator","inputs":inputs,"outputs":[{"label":"Result","unit":"$","expression":expression}]})
    }

    fn singular_at(value: f64) -> Value {
        json!({"op":"divide","left":1,"right":{"op":"subtract","left":{"input":0},"right":value}})
    }

    #[test]
    fn decimal_grid_matches_reachable_ticks_and_interior_zero() {
        let check = |min, max, step, initial, bad| {
            validate(&calculator(
                vec![slider("Rate", min, max, step, initial)],
                singular_at(bad),
            ))
        };
        assert!(check(0.1, 0.35, 0.1, 0.1, 0.3)
            .unwrap_err()
            .contains("Rate = 0.3"));
        check(0.1, 0.35, 0.1, 0.1, 0.35).unwrap();
        assert!(check(1.0, 9.0, 1.0, 5.0, 7.0).is_err());
        assert!(check(-1e-5, 1e-5, 1e-8, 1e-5, 0.0).is_err());
        check(-999.0, 999.0, 2.0, 1.0, 0.0).unwrap();
        // Roughly 2e332 steps; never allocate the grid or convert the count to a machine integer.
        check(0.0, 1e9, 5e-324, 0.0, -1.0).unwrap();
    }

    #[test]
    fn tests_combined_endpoints_with_an_input_at_its_default() {
        let inputs = ["A", "B", "C"]
            .iter()
            .map(|label| slider(label, 0.0, 1000.0, 1.0, 500.0))
            .collect();
        let offset = json!({"op":"subtract","left":{"input":2},"right":500});
        let expr = json!({"op":"divide","left":1,"right":{"op":"add","left":{
            "op":"add","left":{"input":0},"right":{"op":"subtract","left":1000,"right":{"input":1}}},
            "right":{"op":"multiply","left":offset,"right":offset}}});
        assert!(validate(&calculator(inputs, expr))
            .unwrap_err()
            .contains("A = 0, B = 1000, C = 500"));
    }

    #[test]
    fn accepts_valid_mortgage_and_rejects_invalid_payment_domains() {
        let inputs = vec![
            slider("Principal", 0.0, 500000.0, 1000.0, 400000.0),
            slider("Annual rate", 0.0, 12.0, 0.25, 6.0),
            slider("Term", 1.0, 30.0, 1.0, 30.0),
        ];
        let payment = json!({"op":"periodicPayment","principal":{"input":0},
            "ratePerPeriod":{"op":"divide","left":{"input":1},"right":1200},
            "periods":{"op":"multiply","left":{"input":2},"right":12}});
        validate(&calculator(inputs, payment.clone())).unwrap();
        let expr = Expression::parse(&payment, 3, 0, &mut 63).unwrap();
        assert!((expr.evaluate(&[400000.0, 6.0, 30.0]).unwrap() - 2398.202100611010).abs() < 1e-9);
        assert_eq!(
            expr.evaluate(&[400000.0, 0.0, 30.0]),
            Some(400000.0 / 360.0)
        );
        assert_eq!(expr.evaluate(&[400000.0, 6.0, 0.0]), None);
        assert_eq!(expr.evaluate(&[400000.0, 6.0, 0.125]), None);
    }

    #[test]
    fn enforces_expression_shape_node_budget_and_input_rules() {
        let valid = || vec![slider("Input", 0.0, 4.0, 0.5, 1.0)];
        let mut sixty_three = json!(1);
        for _ in 0..5 {
            sixty_three = json!({"op":"add","left":sixty_three,"right":sixty_three});
        }
        validate(&calculator(valid(), sixty_three.clone())).unwrap();
        for malformed in [
            json!({"op":"add","left":0,"right":sixty_three}),
            json!({"op":"periodicPayment","principal":1,"ratePerPeriod":0,"periods":0}),
            json!({"input":1}),
            json!({"input":0,"op":"other"}),
            json!({"op":"unknown","left":0,"right":0}),
        ] {
            assert!(validate(&calculator(valid(), malformed)).is_err());
        }
        assert!(validate(&calculator(
            vec![slider("Input", 0.0, 2.0, 0.5, 0.2)],
            json!(0)
        ))
        .is_err());
    }
}
