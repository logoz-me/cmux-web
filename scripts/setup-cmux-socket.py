#!/usr/bin/env python3
"""Configure le socket de controle cmux pour un client externe (cmux-web).

Le mot de passe du socket n'est pas stocke dans cmux.json : cmux le garde dans
son propre fichier d'etat. Ce script ecrit donc ce fichier, puis passe le mode
d'acces en "password" dans cmux.json — en preservant les commentaires du
fichier, que cmux accepte (JSONC).
"""

import argparse
import json
import pathlib
import secrets
import stat

STATE_DIR = pathlib.Path.home() / ".local" / "state" / "cmux"
PASSWORD_FILE = STATE_DIR / "socket-control-password"
CONFIG_FILE = pathlib.Path.home() / ".config" / "cmux" / "cmux.json"
MODE = "password"


def strip_jsonc(text):
    """Retire les commentaires // et /* */ d'un JSONC (sans toucher aux chaines)."""
    out = []
    i = 0
    n = len(text)
    in_string = False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _depth_at(text, index):
    """Profondeur d'accolades avant index, en ignorant les chaines."""
    depth = 0
    in_string = False
    i = 0
    while i < index:
        c = text[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c in "{[":
            depth += 1
        elif c in "}]":
            depth -= 1
        i += 1
    return depth


def find_key_block(text, key):
    """Retourne (debut, fin) du bloc d'un objet de premier niveau, ou None."""
    needle = '"%s"' % key
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx < 0:
            return None
        # Les cles de premier niveau sont a profondeur 1 (l'accolade racine
        # est deja ouverte quand on les rencontre).
        if _depth_at(text, idx) != 1:
            start = idx + 1
            continue
        colon = text.find(":", idx + len(needle))
        if colon < 0:
            return None
        j = colon + 1
        while j < len(text) and text[j] in " \t\r\n":
            j += 1
        if j >= len(text) or text[j] != "{":
            return None
        depth = 0
        in_string = False
        k = j
        while k < len(text):
            c = text[k]
            if in_string:
                if c == "\\":
                    k += 2
                    continue
                if c == '"':
                    in_string = False
            elif c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return (j, k + 1)
            k += 1
        return None


def set_mode(text, mode):
    """Insere ou remplace automation.socketControlMode en preservant le reste."""
    span = find_key_block(text, "automation")
    if span:
        begin, end = span
        block = text[begin:end]
        try:
            data = json.loads(strip_jsonc(block))
        except ValueError:
            data = {}
        data["socketControlMode"] = mode
        dumped = json.dumps(data, indent=2, ensure_ascii=False)
        # On re-indente le bloc pour qu'il s'aligne sur le fichier hote.
        new_block = "\n".join(
            ("  " + line) if index else line
            for index, line in enumerate(dumped.split("\n"))
        )
        return text[:begin] + new_block + text[end:]

    # pas de bloc "automation" : on l'ajoute avant la derniere accolade racine.
    depth = 0
    in_string = False
    last_brace = -1
    i = 0
    while i < len(text):
        c = text[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                last_brace = i
        i += 1
    if last_brace < 0:
        raise SystemExit("cmux.json : accolade racine introuvable")

    body = text[:last_brace].rstrip()
    # Une virgule est necessaire sauf si l'objet racine est encore vide.
    prefix = "\n  " if body.endswith("{") else ",\n  "
    block = prefix + '"automation" : {\n    "socketControlMode" : "%s"\n  }' % mode
    return body + block + "\n" + text[last_brace:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rotate", action="store_true",
                        help="regenere un nouveau mot de passe")
    parser.add_argument("--mode", default=MODE,
                        help="mode d'acces du socket (defaut: password)")
    args = parser.parse_args()

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    created = False
    if args.rotate or not PASSWORD_FILE.exists():
        secret = secrets.token_urlsafe(32)
        PASSWORD_FILE.write_text(secret)
        PASSWORD_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)
        created = True
    password = PASSWORD_FILE.read_text().strip()
    if not password:
        raise SystemExit("fichier de mot de passe vide : %s" % PASSWORD_FILE)

    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    text = CONFIG_FILE.read_text() if CONFIG_FILE.exists() else "{}\n"
    updated = set_mode(text, args.mode)
    if updated != text:
        CONFIG_FILE.write_text(updated)
        CONFIG_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)

    print("mode        :", args.mode)
    print("mot de passe:", "nouveau" if created else "conserve", "->", PASSWORD_FILE)
    print("config      :", CONFIG_FILE)


if __name__ == "__main__":
    main()
