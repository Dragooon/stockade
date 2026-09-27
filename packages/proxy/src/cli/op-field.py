#!/usr/bin/env python3
"""op-field — generic 1Password item/field resolver for the credential proxy.

Runs on the HOST (inside the proxy's provider commands), never in agent
containers. Lets agents address any item in the vault by name without a
per-key override in proxy.yaml.

Usage:
  op-field.py read  <item>[/<field>]     print the field value
  op-field.py shape <item>               print item structure as JSON (secrets hidden)
  op-field.py store <item>[/<field>]     create/update field from $APW_STORE_VALUE

Key resolution:
  <item>   matched against vault item titles, exact first, then normalised
           (case-insensitive, [-_ ] collapsed) so "tailscale-api-key" also
           matches "Tailscale API Key".
  <field>  matched against field labels the same way (or field id). When
           omitted on read: first of api key / credential / token / secret /
           password / key / value / notesPlain, else the only CONCEALED field.
           When omitted on store: "api key".

Env:
  OP_ACCOUNT   account shorthand (default: my)
  OP_VAULT     vault name (default: Shared)
  OP_SESSION_* injected by the proxy after signin
"""
import json
import os
import re
import shutil
import subprocess
import sys

ACCOUNT = os.environ.get("OP_ACCOUNT", "my")
VAULT = os.environ.get("OP_VAULT", "Shared")
OP = shutil.which("op") or "op"

DEFAULT_READ_FIELDS = ["api key", "credential", "token", "secret", "password", "key", "value", "notesPlain"]
DEFAULT_STORE_FIELD = "api key"
# Field labels/types whose values never appear in `shape` output.
HIDDEN_TYPES = {"CONCEALED"}
HIDDEN_LABELS = {"notesplain", "password", "api key", "credential", "token", "secret"}


def die(msg, code=1):
    sys.stderr.write(f"op-field: {msg}\n")
    sys.exit(code)


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def op(*args, check=True):
    cmd = [OP, *args, "--account", ACCOUNT]
    r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if check and r.returncode != 0:
        die((r.stderr or r.stdout).strip() or f"op exited {r.returncode}")
    return r


def split_key(key):
    if "/" in key:
        item, field = key.split("/", 1)
        return item.strip(), field.strip()
    return key.strip(), None


def find_item(name):
    """Return the item JSON, or None if no item matches."""
    # Fast path: exact title (or id).
    r = op("item", "get", name, "--vault", VAULT, "--format", "json", check=False)
    if r.returncode == 0:
        return json.loads(r.stdout)
    # Slow path: normalised title match across the vault.
    items = json.loads(op("item", "list", "--vault", VAULT, "--format", "json").stdout)
    want = norm(name)
    hits = [i for i in items if norm(i["title"]) == want]
    if len(hits) > 1:
        die(f"ambiguous item '{name}': " + ", ".join(i["title"] for i in hits))
    if not hits:
        return None
    return json.loads(op("item", "get", hits[0]["id"], "--vault", VAULT, "--format", "json").stdout)


def field_label(f):
    return f.get("label") or f.get("id") or ""


def find_field(item, name):
    fields = item.get("fields", [])
    want = norm(name)
    for f in fields:
        if f.get("id") == name or norm(field_label(f)) == want:
            return f
    return None


def pick_default_field(item):
    fields = [f for f in item.get("fields", []) if f.get("value")]
    for want in DEFAULT_READ_FIELDS:
        for f in fields:
            if norm(field_label(f)) == norm(want):
                return f
    concealed = [f for f in fields if f.get("type") in HIDDEN_TYPES]
    if len(concealed) == 1:
        return concealed[0]
    die("no field given and none could be inferred; fields: "
        + ", ".join(field_label(f) for f in item.get("fields", [])))


def cmd_read(key):
    item_name, field_name = split_key(key)
    item = find_item(item_name)
    if item is None:
        die(f"no item '{item_name}' in vault {VAULT}")
    if field_name:
        f = find_field(item, field_name)
        if f is None:
            die(f"no field '{field_name}' on '{item['title']}'; fields: "
                + ", ".join(field_label(x) for x in item.get("fields", [])))
    else:
        f = pick_default_field(item)
    sys.stdout.write(f.get("value") or "")


def cmd_shape(key):
    item_name, _ = split_key(key)
    item = find_item(item_name)
    if item is None:
        die(f"no item '{item_name}' in vault {VAULT}")
    fields = []
    for f in item.get("fields", []):
        label = field_label(f)
        hidden = f.get("type") in HIDDEN_TYPES or norm(label) in HIDDEN_LABELS
        entry = {"label": label, "type": f.get("type"), "set": bool(f.get("value"))}
        if f.get("section", {}).get("label"):
            entry["section"] = f["section"]["label"]
        if not hidden and f.get("value"):
            entry["value"] = f["value"]
        fields.append(entry)
    out = {
        "title": item["title"],
        "category": item.get("category"),
        "vault": item.get("vault", {}).get("name", VAULT),
        "updated_at": item.get("updated_at"),
        "urls": [u.get("href") for u in item.get("urls", [])],
        "fields": fields,
        "read_key": item["title"] if " " not in item["title"] else norm(item["title"]).replace(" ", "-"),
    }
    json.dump(out, sys.stdout, indent=2)


def cmd_store(key):
    value = os.environ.get("APW_STORE_VALUE")
    if not value:
        die("APW_STORE_VALUE is empty")
    item_name, field_name = split_key(key)
    field_name = field_name or DEFAULT_STORE_FIELD
    item = find_item(item_name)
    if item is None:
        op("item", "create", "--category=apicredential", f"--title={item_name}",
           "--vault", VAULT, f"{field_name}[password]={value}")
        sys.stdout.write(f"created {item_name}/{field_name}")
        return
    existing = find_field(item, field_name)
    assignment = (f"{field_label(existing)}={value}" if existing
                  else f"{field_name}[password]={value}")
    op("item", "edit", item["id"], "--vault", VAULT, assignment)
    sys.stdout.write(f"updated {item['title']}/{field_name}")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("read", "shape", "store"):
        die(__doc__.strip(), 2)
    {"read": cmd_read, "shape": cmd_shape, "store": cmd_store}[sys.argv[1]](sys.argv[2])


if __name__ == "__main__":
    main()
