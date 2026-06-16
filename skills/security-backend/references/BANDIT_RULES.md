# Bandit Rule Reference (inline-checked subset)

The skill emits `bandit -r backend/ -ll -ii` for the user to run, but ALSO inline-greps the highest-impact rules so findings appear in the same report. This file documents the rule IDs and grep equivalents.

Full Bandit rule catalog: https://bandit.readthedocs.io/en/latest/plugins/index.html

## Rules grep-checked inline

| Rule | Name | Severity | Grep equivalent | Catalog ref |
|---|---|---|---|---|
| **B102** | `exec_used` | HIGH | `Grep "\bexec\(" --type py -n` in `backend/` | 3.3 |
| **B301** | `pickle` | MEDIUM | `Grep "pickle\.loads?" --type py -n` in `backend/` | 3.5 |
| **B302** | `marshal` | MEDIUM | `Grep "marshal\.loads?" --type py -n` in `backend/` | 3.5 |
| **B306** | `mktemp_q` | MEDIUM | `Grep "tempfile\.mktemp\(" --type py -n` in `backend/` | path/file race |
| **B307** | `eval` | HIGH | `Grep "\beval\(" --type py -n` in `backend/` | 3.3 |
| **B311** | `random` | LOW | `Grep "\brandom\.(random\|randint\|choice)" --type py -n` near security context | crypto / token gen |
| **B324** | `hashlib_insecure_functions` | HIGH | `Grep "hashlib\.(md5\|sha1)\(" --type py -n` | weak hash |
| **B404** | `import_subprocess` | LOW | `Grep "^import subprocess\|^from subprocess" --type py -n` in `backend/` | 3.3 (command inj) |
| **B501** | `request_with_no_cert_validation` | HIGH | `Grep "verify=False" --type py -n` in `backend/` | TLS bypass |
| **B502** | `ssl_with_bad_version` | HIGH | `Grep "ssl_version=ssl\.(SSLv2\|SSLv3\|TLSv1\b)" --type py -n` | weak TLS |
| **B503** | `ssl_with_bad_defaults` | MEDIUM | `Grep "ssl\.PROTOCOL_(SSLv2\|SSLv3\|TLSv1\b)" --type py -n` | weak TLS |
| **B506** | `yaml_load` | MEDIUM | `Grep "yaml\.load\(" --type py -n` (without `SafeLoader`) | 3.5 |
| **B602** | `subprocess_popen_with_shell_equals_true` | HIGH | `Grep "subprocess\.Popen\(.*shell=True" --type py -n` | 3.3 |
| **B603** | `subprocess_without_shell_equals_true` | LOW | (audit per-call) | 3.3 |
| **B608** | `hardcoded_sql_expressions` | MEDIUM | `Grep "execute.*\bf['\"]\|execute.*%.*\b%\b" --type py -n` | 3.1 / 3.2 |
| **B701** | `jinja2_autoescape_false` | HIGH | `Grep "autoescape=False" --type py -n` | XSS in server-rendered HTML |

## Rules NOT grep-checked (defer to Bandit binary)

These require AST-level analysis Bandit does better than grep:

- **B105** `hardcoded_password_string` — Bandit's literal detection
- **B107** `hardcoded_password_default` — same
- **B201** `flask_debug_true` — covered by 6.5 in CHECK_CATALOG.md for FastAPI
- **B608** subset — SQL formatting in complex AST contexts

When the user runs `bandit -r backend/ -ll -ii`, surface any HIGH or MEDIUM findings as P0/P1 entries in the next audit run.

## How to emit the script

In the output section:

```bash
# Run from repo root
bandit -r backend/ -ll -ii --skip B404,B603
```

The `--skip B404,B603` suppresses Bandit's low-severity "subprocess imported" / "subprocess called" noise — the audit catches command-injection inline (3.3) and Bandit's bare-import warnings are noise without further AST context.
