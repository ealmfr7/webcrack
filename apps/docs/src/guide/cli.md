# Command Line Interface

Install the package globally:

::: code-group

```bash [npm]
npm install -g webcrack@latest
```

```bash [yarn]
yarn global add webcrack@latest
```

```bash [pnpm]
pnpm add -g webcrack@latest --allow-build=isolated-vm
```

:::

```txt
Usage: webcrack [options] [files...]

Arguments:
  files                        input files, defaults to stdin

Options:
  -V, --version                output the version number
  -o, --output <path>          output directory for bundled files
  -f, --force                  overwrite output directory
  -m, --mangle                 mangle variable names
  --no-jsx                     do not decompile JSX
  --no-unpack                  do not extract modules from the bundle
  --no-deobfuscate             do not deobfuscate the code
  --no-unminify                do not unminify the code
  --report                     collect URLs, endpoints, secrets and other findings
  --graph                      build the module dependency and call graphs
  --trace                      record a per-stage transform trace
  --source-map                 emit a source map of the deobfuscated code
  --rename-heuristics          rename short or mangled variable names using heuristics
  --library-mappings           name modules matching known open-source libraries
  --llm-rename-command <cmd>   external command for LLM-based renaming
                               (batch JSON on stdin, {old:new} map on stdout)
  --llm-timeout <ms>           timeout in ms for the LLM rename command
                               (default: 30000)
  -h, --help                   display help for command
```

The code can be passed as a file or via stdin:

```bash
webcrack input.js
# or download/pipe a script from a website
curl https://pastebin.com/raw/ye3usFvH | webcrack
```

By default it outputs debug logs and the deobfuscated/unminified code to the terminal.
To write the code to a file, you can do:

```bash
webcrack input.js > output.js
```

## Unpack Bundles

Use the `-o` option to unpack a bundle into a directory:

```bash
webcrack bundle.js -o output
```

The output directory will contain the following files:

- `deobfuscated.js` - deobfuscated/unminified code
- `bundle.json` - bundle type and module ids/paths
- `index.js` - entry point
- all remaining modules (`1.js`, `2.js`, etc.)

With `--report`, a `report.json` with URLs, endpoints, secrets and other
findings is written as well. With `--graph`, `graph.modules.json`/`.dot`
(module dependencies, only when a bundle was found) and
`graph.calls.json`/`.dot` (call graph) are written. With `--source-map`, a
`deobfuscated.js.map` file is written and referenced from `deobfuscated.js`.
With `--trace`, the per-stage transform diffs are written to `trace.diff`.

## Multiple input files

Some apps split their bundle into several chunk files (a runtime/entry file
plus additional chunks). Pass them all at once to merge them into a single
bundle. Multiple inputs require the `-o` option:

```bash
webcrack runtime.js chunk-a.js chunk-b.js -o output
```

Each input is deobfuscated on its own then all outputs are merged. The merged
bundle (`bundle.json` plus modules) is saved to the output directory, while
the per-input files (`deobfuscated.js`, and `report.json`/`graph.*`/
`trace.diff`/`deobfuscated.js.map` when the matching flags are enabled) are
saved under `<output>/<basename>/` directories named after each input file.
When several inputs share the same base file name, the later directories get
`-2`, `-3`, … suffixes. Warnings (ignored inputs, duplicate module ids) and
unresolved cross-chunk references are printed to stderr.

## LLM-based renaming

The `--llm-rename-command <cmd>` option renames short or mangled variable
names using an external command, e.g. a script that calls an LLM. The command
is spawned with a shell: for each batch, a JSON array of
`{name, kind, context, scopeType}` objects is written to its stdin and a JSON
object mapping current names to suggested names (`{"a": "userCount"}`) is read
from its stdout. Unknown names and invalid suggestions are ignored. A batch
whose command exits non-zero, times out or prints invalid JSON is skipped with
a warning. `--llm-timeout <ms>` (default `30000`) controls how long to wait
for each batch:

```bash
webcrack bundle.js -o output --llm-rename-command "llm-rename" --llm-timeout 60000
```

Exactly which outputs are renamed depends on the inputs and whether `-o`
is used:

- Without `-o`, the code printed to stdout is the renamed code.
- With `-o` and a single input containing a bundle, the extracted module
  files are renamed; `deobfuscated.js` is not.
- With `-o` and a single input without a bundle, `deobfuscated.js` is
  renamed.
- With multiple inputs and a merged bundle, the merged module files are
  renamed; each per-input `<output>/<basename>/deobfuscated.js` is not.
- With multiple inputs and no bundle, each per-input
  `<output>/<basename>/deobfuscated.js` is renamed.

`--source-map` cannot be combined with `--llm-rename-command`: the CLI exits
with an error. `--llm-timeout <ms>` must be an integer between `1` and
`2147483647` ms. The value is parsed with `Number()`, so `1e4` is accepted as
`10000` while a value like `10s` is rejected.

## Invoke from other programming languages

If the package is installed locally instead of globally, the path of the CLI would look like `node_modules/.bin/webcrack`.

Spawn a new process where the code is piped to stdin.
The logs will be written to stderr and the output code will be written to stdout.

Example in Python:

```py
import subprocess

code = "1+1"
result = subprocess.run(
    ["webcrack"], input=code, capture_output=True, text=True
)
print(result.stdout)
```
