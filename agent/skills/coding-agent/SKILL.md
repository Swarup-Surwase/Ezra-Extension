---
name: coding-agent
description: Specialized instructions and engineering workflows for repository inspection, multi-file code editing, and verification in VS Code.
---

# TrueForge Coding Agent Skill

This skill guides the agent in executing software engineering tasks inside an editor-native environment.

## 1. Autonomous Repository Exploration
- Before proposing any edits, inspect the repository structure with `file_search` and `grep_search`.
- Inspect relevant symbol definitions with `find_symbols`.
- Read target files with `read_file`, specifying line ranges if files exceed 150 lines.

## 2. Multi-File Changes
- Identify all files that require modification:
  - Source implementation files (e.g. `src/...`)
  - Test suite files (e.g. `tests/...`)
  - Documentation files (e.g. `docs/...`)
- Propose edits file-by-file using `propose_edit`.
- For each file, ensure `oldStr` matches the original file text exactly to allow clean hunk generation.

## 3. Human-in-the-Loop Review
- Remember: Calling `propose_edit` stages changes in VS Code for the user to review.
- The user can accept or reject individual hunks or accept all changes.
- Never claim files are saved until the user has accepted the hunks.

## 4. Verification and Testing
- Once changes are staged or applied, execute test suites using `execute_command`.
- Formulate precise, focused test commands (e.g., `pytest tests/test_cli.py -q`).
- Show stdout/stderr results to the user.

