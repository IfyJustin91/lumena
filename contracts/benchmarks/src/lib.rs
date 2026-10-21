//! Soroban Gas and Resource Footprint Profiling Library
//!
//! This crate provides types and utilities for measuring CPU instructions and
//! memory consumption of Soroban smart contract operations using the testutils
//! budget API.  Results are serialized to JSON so the web viewer can display
//! them in a rich table.

extern crate std;

use serde::{Deserialize, Serialize};

/// A single benchmark measurement captured after one contract invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResult {
    /// Human-readable name of the benchmark.
    pub name: String,
    /// CPU instructions consumed (soroban budget units).
    pub cpu_instructions: u64,
    /// Memory bytes consumed (soroban budget units).
    pub memory_bytes: u64,
    /// Whether this result is within the defined budget thresholds.
    pub within_budget: bool,
    /// The CPU instruction budget ceiling for this benchmark.
    pub cpu_budget: u64,
    /// The memory budget ceiling for this benchmark.
    pub mem_budget: u64,
    /// Optional percentage of CPU budget used (0-100+).
    pub cpu_pct: f64,
    /// Optional percentage of memory budget used (0-100+).
    pub mem_pct: f64,
}

impl BenchmarkResult {
    pub fn new(
        name: impl Into<String>,
        cpu_instructions: u64,
        memory_bytes: u64,
        cpu_budget: u64,
        mem_budget: u64,
    ) -> Self {
        let within_budget = cpu_instructions <= cpu_budget && memory_bytes <= mem_budget;
        let cpu_pct = if cpu_budget > 0 {
            cpu_instructions as f64 / cpu_budget as f64 * 100.0
        } else {
            0.0
        };
        let mem_pct = if mem_budget > 0 {
            memory_bytes as f64 / mem_budget as f64 * 100.0
        } else {
            0.0
        };
        Self {
            name: name.into(),
            cpu_instructions,
            memory_bytes,
            within_budget,
            cpu_budget,
            mem_budget,
            cpu_pct,
            mem_pct,
        }
    }
}

/// A collection of benchmark results for reporting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkReport {
    pub results: Vec<BenchmarkResult>,
    pub all_pass: bool,
    pub timestamp: String,
}

impl BenchmarkReport {
    pub fn new(results: Vec<BenchmarkResult>) -> Self {
        let all_pass = results.iter().all(|r| r.within_budget);
        Self {
            all_pass,
            results,
            timestamp: "".into(), // filled by runner
        }
    }

    /// Pretty-print a resource table to stdout.
    pub fn print_table(&self) {
        let col_name = 42usize;
        let col_cpu = 20usize;
        let col_mem = 20usize;
        let col_cpu_pct = 12usize;
        let col_mem_pct = 12usize;
        let col_status = 10usize;

        let separator = format!(
            "+-{:-<w1$}-+-{:-<w2$}-+-{:-<w3$}-+-{:-<w4$}-+-{:-<w5$}-+-{:-<w6$}-+",
            "",
            "",
            "",
            "",
            "",
            "",
            w1 = col_name,
            w2 = col_cpu,
            w3 = col_mem,
            w4 = col_cpu_pct,
            w5 = col_mem_pct,
            w6 = col_status,
        );

        println!("\n{}", separator);
        println!(
            "| {:<w1$} | {:>w2$} | {:>w3$} | {:>w4$} | {:>w5$} | {:<w6$} |",
            "Benchmark",
            "CPU Instructions",
            "Memory Bytes",
            "CPU %",
            "Mem %",
            "Status",
            w1 = col_name,
            w2 = col_cpu,
            w3 = col_mem,
            w4 = col_cpu_pct,
            w5 = col_mem_pct,
            w6 = col_status,
        );
        println!("{}", separator);

        for r in &self.results {
            let status = if r.within_budget { "✓ PASS" } else { "✗ FAIL" };
            println!(
                "| {:<w1$} | {:>w2$} | {:>w3$} | {:>w4$.1} | {:>w5$.1} | {:<w6$} |",
                r.name,
                r.cpu_instructions,
                r.memory_bytes,
                r.cpu_pct,
                r.mem_pct,
                status,
                w1 = col_name,
                w2 = col_cpu,
                w3 = col_mem,
                w4 = col_cpu_pct,
                w5 = col_mem_pct,
                w6 = col_status,
            );
        }

        println!("{}\n", separator);

        let failed: Vec<_> = self.results.iter().filter(|r| !r.within_budget).collect();
        if failed.is_empty() {
            println!("✓  All {} benchmarks passed resource budgets.", self.results.len());
        } else {
            println!(
                "✗  {} of {} benchmarks EXCEEDED resource budgets:",
                failed.len(),
                self.results.len()
            );
            for r in &failed {
                if r.cpu_instructions > r.cpu_budget {
                    println!(
                        "   - {}: CPU {} > budget {} ({:.1}%)",
                        r.name, r.cpu_instructions, r.cpu_budget, r.cpu_pct
                    );
                }
                if r.memory_bytes > r.mem_budget {
                    println!(
                        "   - {}: MEM {} > budget {} ({:.1}%)",
                        r.name, r.memory_bytes, r.mem_budget, r.mem_pct
                    );
                }
            }
        }
        println!();
    }
}
