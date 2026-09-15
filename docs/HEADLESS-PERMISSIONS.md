# Headless permissions: diagnose before granting access

The Antigravity provider invokes the official `agy` CLI directly. A model-selection label inherited from another provider does not turn this bridge into an API-router call.

## Reproduction

With AGY 1.2.2, run from a project directory in `plan` mode and request `list_dir` or `view_file` for a directory outside that workspace that has no read allow-rule. Use a disposable directory containing synthetic files, not private data.

```sh
agy --model gemini-3.8-flash --effort high --mode plan \
  --output-format stream-json --print-timeout 90s \
  --print 'Use list_dir on /tmp/agy-shared-fixture. Do not modify anything or use alternative tools. If denied, stop.'
```

In a noninteractive invocation, a request that requires approval can be automatically denied because no interactive permission prompt can be answered. The wording `user denied permission` in a recorded tool error does not establish that a human clicked Deny. Switching from `plan` to `accept-edits` is not an authorization for arbitrary external directories.

## Least-privilege remediation

1. Back up the effective AGY settings privately. In the verified Linux AGY 1.2.2 installation, the CLI reads `~/.gemini/antigravity-cli/settings.json`. Verify the path for the installed version/platform; never copy credential stores into an issue.
2. Preserve the entire existing configuration and permission list. Add only the required read rule to `permissions.allow`, for example `read_file(/tmp/agy-shared-fixture)`. This is an individual array entry, not a replacement settings file.
3. Test directory listing, a direct child file, a nested child, and a sibling outside the allowed directory. On the verified AGY 1.2.2 installation, this directory rule allowed reads in the subtree and denied the sibling. Revalidate on other versions; this is not a claim about undocumented wildcard or symlink semantics.
4. Test the actual required skill path from the actual project working directory. Keep `plan` for this read-only proof. Do not add `command(...)`, write rules or `--dangerously-skip-permissions` to make the check green.
5. Read the recorded `step_update` tool outcome. An exit code of zero, a `SUCCESS` process result, or model prose is not enough: the AGY envelope can say success even when an individual tool failed or the final response is empty.
6. Verify a fresh DSH turn after deployment. Preserve the original failing session; do not rewrite its history. A newly spawned CLI reads its settings, so a server restart is not automatically required for a permission-list change.

A directory read rule is broader than a single file rule. Choose the narrowest paths required by the intended workflow and do not grant the entire home directory. Existing shell permissions are outside the guarantee of this read-tool check: the denied fixture test must not use an alternative command to bypass the failure.

## Separate integration defects

PR #15 fixes lifecycle cleanup and continuation detection. A trailing context snapshot can hide a tool result from a last-message-only detector. The follow-up constrains skipping to the declared `snapshot` form; plugin instructions, notices and human messages remain boundaries. Neither fix grants filesystem access.

Keep process completion, tool errors and user-visible response completeness separate when reporting readiness. Do not claim the whole turn passed when only a read tool passed.
