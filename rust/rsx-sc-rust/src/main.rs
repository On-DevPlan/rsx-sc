//! rsx-sc-rust — capture-only screenshot binary.
//!
//! Multi-call dispatcher:
//!   * `rsx-sc-rust`             → print usage + exit 1
//!   * `rsx-sc-rust capture`     → one-shot monitor capture (PNG base64)
//!   * `rsx-sc-rust crop`        → crop a rectangle out of a PNG
//!   * `rsx-sc-rust loop_capture`→ continuous region capture (PNG frames stream)
//!   * `rsx-sc-rust select`      → native fullscreen box-select overlay;
//!                                 prints the chosen region as JSON on stdout
//!
//! Invoked by the Node `capture-client.js` driver over stdio (JSONL envelopes
//! on stdin/stdout). Each node owns its own stdin/stdout lifecycle; `run`
//! functions never return to this dispatcher once the node starts.

mod core;
mod error;
mod overlay;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let name = match args.get(1) {
        Some(n) => n.as_str(),
        None => {
            print_usage();
            std::process::exit(2);
        }
    };

    // Multi-thread runtime is required: loop_capture runs a spawn_blocking
    // capture loop AND a tokio task that races against signals. single-thread
    // would deadlock the blocking thread waiting for the signal task.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    let code = match rt.block_on(core::run_node(name)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("node '{name}' failed: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn print_usage() {
    eprintln!(
        "rsx-sc-rust — capture binary (v{})\n\
         \n\
         Usage:\n  \
           rsx-sc-rust <node>\n\
         \n\
         Nodes:\n  \
           capture       one-shot monitor capture (PNG base64)\n  \
           crop          crop a rectangle out of a PNG\n  \
           loop_capture  continuous region capture (PNG frames stream)\n  \
           select        native fullscreen box-select overlay (JSON on stdout)\n",
        env!("CARGO_PKG_VERSION")
    );
}