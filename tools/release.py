#!/usr/bin/env python3
"""Stamp a cache-busting version into every relative ES-module import and into index.html.

GitHub Pages serves files with max-age=600 and Telegram WebViews cache aggressively, so after a
deploy a client could mix old and new modules. Run this right before committing a release:

    python3 tools/release.py            # version = git short hash (+ "d" if the tree is dirty)
    python3 tools/release.py --version 20260927a
    python3 tools/release.py --check    # exit 1 if anything would change (CI / pre-push)

It rewrites  from './x.js'  /  import './x.js'  /  import('./x.js')  in src/**/*.js to
'./x.js?v=VERSION' and stamps  src/main.js  and  styles.css  in index.html. Idempotent: an
existing ?v= is replaced. Local dev works without it (unstamped imports are fine).
Stdlib only.
"""
import argparse
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent

# import/export ... from './x.js' | import './x.js' | import('./x.js')  (relative specifiers only)
IMPORT_RE = re.compile(
    r"""(?P<head>\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?P<q>['"])(?P<path>\.{1,2}/[^'"?#]+?\.js)(?:\?v=[^'"#]*)?(?P=q)"""
)
HTML_RE = re.compile(
    r"""(?P<head>\b(?:src|href)=)(?P<q>['"])(?P<path>(?:src/main\.js|styles\.css))(?:\?v=[^'"#]*)?(?P=q)"""
)


def git_version():
    try:
        rev = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = subprocess.call(['git', 'diff', '--quiet', 'HEAD', '--', '.', ':!src/**/*.js', ':!index.html'],
                                cwd=ROOT) != 0
        return rev + ('d' if dirty else '')
    except (OSError, subprocess.CalledProcessError):
        return time.strftime('%Y%m%d%H%M%S')


def stamp(text, pattern, version):
    return pattern.sub(lambda m: f"{m['head']}{m['q']}{m['path']}?v={version}{m['q']}", text)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--version', help='version string (default: git short hash or timestamp)')
    ap.add_argument('--check', action='store_true', help='only report; exit 1 if files would change')
    args = ap.parse_args()
    version = args.version or git_version()
    if not re.fullmatch(r'[A-Za-z0-9._-]+', version):
        sys.exit(f'bad version string: {version!r}')

    targets = [(p, IMPORT_RE) for p in sorted((ROOT / 'src').rglob('*.js'))]
    targets.append((ROOT / 'index.html', HTML_RE))
    changed = []
    for path, pattern in targets:
        old = path.read_text(encoding='utf-8')
        new = stamp(old, pattern, version)
        if new != old:
            changed.append(path.relative_to(ROOT))
            if not args.check:
                path.write_text(new, encoding='utf-8')

    verb = 'would change' if args.check else 'stamped'
    print(f'version {version}: {verb} {len(changed)} file(s)')
    for p in changed:
        print(f'  {p}')
    if args.check and changed:
        sys.exit(1)


if __name__ == '__main__':
    main()
