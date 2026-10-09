"""Where the Gothic II installation is: the GOTHIC2_DIR environment variable.

GOTHIC2_DIR is the game's install root, the folder that holds Data/ and System/ (Steam: steamapps/common/Gothic II).
Every tool that reads the game archives resolves its paths here, so nothing in the repository points at one machine.
Names are looked up case-insensitively (an install on a case-sensitive file system may have system/ or textures.vdf).
"""
import os
import sys

ENV = 'GOTHIC2_DIR'
HINT = (f'{ENV} must point at your Gothic II Gold install, the folder with Data/ and System/, e.g.\n'
        f'  export {ENV}="$HOME/.steam/steam/steamapps/common/Gothic II"\n'
        'See README.md, "Reproduce from your own copy of the game".')


def find_ci(base, *parts):
    """`base/parts...` with every part matched case-insensitively; None if some part does not exist."""
    path = base
    for part in parts:
        exact = os.path.join(path, part)
        if os.path.exists(exact):
            path = exact
            continue
        try:
            match = next((n for n in os.listdir(path) if n.lower() == part.lower()), None)
        except OSError:
            return None
        if match is None:
            return None
        path = os.path.join(path, match)
    return path


def game_dir(env=ENV):
    """The install root from the environment; exits with a clear message when it is unset or wrong."""
    d = os.environ.get(env, '').strip()
    if not d:
        sys.exit(f'{env} is not set.\n{HINT}')
    d = os.path.expanduser(d)
    if not os.path.isdir(d) or find_ci(d, 'Data') is None:
        sys.exit(f'{env}={d}: no Data/ folder there.\n{HINT}')
    return d


def data_path(name):
    """Path of an archive in <GOTHIC2_DIR>/Data (exits if it is missing)."""
    root = game_dir()
    p = find_ci(root, 'Data', name)
    if p is None:
        sys.exit(f'{ENV}: {name} not found in {os.path.join(root, "Data")}.\n{HINT}')
    return p


def system_path(name):
    """Path of a file in <GOTHIC2_DIR>/System (exits if it is missing)."""
    root = game_dir()
    p = find_ci(root, 'System', name)
    if p is None:
        sys.exit(f'{ENV}: {name} not found in {os.path.join(root, "System")}.\n{HINT}')
    return p
