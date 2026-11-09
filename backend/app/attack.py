"""MITRE ATT&CK (Enterprise) tactics and techniques named in alerts (FR-13)."""

import re
from enum import StrEnum
from typing import Any

from app.models import Case
from app.observables import strings_in


class Tactic(StrEnum):
    RECONNAISSANCE = "TA0043"
    RESOURCE_DEVELOPMENT = "TA0042"
    INITIAL_ACCESS = "TA0001"
    EXECUTION = "TA0002"
    PERSISTENCE = "TA0003"
    PRIVILEGE_ESCALATION = "TA0004"
    DEFENSE_EVASION = "TA0005"
    CREDENTIAL_ACCESS = "TA0006"
    DISCOVERY = "TA0007"
    LATERAL_MOVEMENT = "TA0008"
    COLLECTION = "TA0009"
    COMMAND_AND_CONTROL = "TA0011"
    EXFILTRATION = "TA0010"
    IMPACT = "TA0040"


def tactic_name(tactic: Tactic) -> str:
    return tactic.name.replace("_", " ").title().replace("And", "and")


_BY_NAME = {tactic_name(t).casefold(): t for t in Tactic}
# A technique ID ends at a non-digit; "T1059." at the end of a sentence still counts.
_TECHNIQUE = re.compile(r"(?<![A-Za-z0-9])T\d{4}(?:\.\d{3})?(?!\d|\.\d)")
_TACTIC = re.compile(r"(?<![A-Za-z0-9])TA\d{4}(?![0-9])")


def find(value: Any) -> tuple[set[str], set[Tactic]]:
    """Technique IDs, and tactics by ID or exact name ("Lateral Movement"), anywhere in a value."""
    techniques: set[str] = set()
    tactics: set[Tactic] = set()
    for text in strings_in(value):
        techniques.update(_TECHNIQUE.findall(text))
        tactics.update(Tactic(t) for t in _TACTIC.findall(text) if t in Tactic)
        if (named := _BY_NAME.get(text.strip().casefold())) is not None:
            tactics.add(named)
    return techniques, tactics


def merge(case: Case, value: Any) -> dict[str, list[str]]:
    """Add the tactics and techniques an alert names to its case; return what was new."""
    techniques, tactics = find(value)
    added = {
        "techniques": sorted(techniques - set(case.attack_techniques)),
        "tactics": sorted(tactics - set(case.attack_tactics)),
    }
    if added["techniques"]:
        case.attack_techniques = sorted({*case.attack_techniques, *techniques})
    if added["tactics"]:
        case.attack_tactics = sorted({*case.attack_tactics, *tactics})
    return {k: v for k, v in added.items() if v}
