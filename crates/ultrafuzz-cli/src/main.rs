use clap::Parser;
use ultrafuzz_cli::{execute, Cli};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let output = execute(cli)?;
    if !output.is_empty() {
        println!("{output}");
    }
    Ok(())
}
