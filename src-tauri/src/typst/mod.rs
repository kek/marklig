//! Embedded Typst compiler. Desktop-only — gated at `lib.rs`.
#![cfg(not(any(target_os = "android", target_os = "ios")))]

pub mod commands;
pub mod diagnostics;
pub mod packages;
pub mod session;
pub mod world;

pub use commands::*;
