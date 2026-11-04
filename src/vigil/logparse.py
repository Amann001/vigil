"""Log template mining: group raw log lines into templates with the Drain algorithm.

"Connection to 10.0.0.5 failed after 3 retries" and "Connection to 10.0.0.9 failed after 5
retries" are one kind of event with different parameters. Grouping lines by template lets Vigil
count kinds of events, and notice a kind it has never seen before.

Drain (He et al., ICWS 2017) does this online in one pass: it routes each line through a fixed
depth tree by length and leading tokens, then joins the most similar existing group or starts a
new one.
"""

from collections import Counter
from collections.abc import Iterable, Sequence

from drain3 import TemplateMiner
from drain3.masking import MaskingInstruction
from drain3.template_miner_config import TemplateMinerConfig

# Values that are always parameters, never part of a template. Masking them before Drain sees
# the line keeps, for example, two IP addresses from looking like different events.
_BOUNDARY_START = r"((?<=[^A-Za-z0-9])|^)"
_BOUNDARY_END = r"((?=[^A-Za-z0-9])|$)"
BASIC_MASKS = [
    (_BOUNDARY_START + r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?)" + _BOUNDARY_END, "IP"),
    (_BOUNDARY_START + r"(0x[a-fA-F0-9]+)" + _BOUNDARY_END, "HEX"),
    (_BOUNDARY_START + r"([\-\+]?\d+(\.\d+)?)" + _BOUNDARY_END, "NUM"),
]
# Experiment, not the default. Drain routes lines by their first tokens, so an instance UUID or
# hostname there gives every instance or host its own group. Masking them cut OpenStack's worst
# template from 21 groups to 2 and Proxifier's from 20 to 9, but left grouping accuracy unchanged
# (0.765 vs 0.767): the metric only credits perfect groups, and the remaining splits come from
# Drain assuming a fixed token count per template (optional "(18.4 KB)" fragments).
EXTENDED_MASKS = [
    (
        _BOUNDARY_START
        + r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
        + _BOUNDARY_END,
        "UUID",
    ),
    BASIC_MASKS[0],
    (_BOUNDARY_START + r"((?:[A-Za-z0-9\-]+\.)+[A-Za-z]{2,}(:\d+)?)" + _BOUNDARY_END, "HOST"),
    *BASIC_MASKS[1:],
]


class LogParser:
    """Online log template miner. Each line gets the id of the template group it joined."""

    def __init__(
        self,
        similarity: float = 0.4,
        depth: int = 4,
        masks: list[tuple[str, str]] = BASIC_MASKS,
    ) -> None:
        config = TemplateMinerConfig()
        config.drain_sim_th = similarity
        config.drain_depth = depth
        config.profiling_enabled = False
        config.masking_instructions = [MaskingInstruction(p, name) for p, name in masks]
        self.miner = TemplateMiner(config=config)

    def add(self, line: str) -> int:
        return self.miner.add_log_message(line)["cluster_id"]

    def parse(self, lines: Iterable[str]) -> list[int]:
        return [self.add(line) for line in lines]

    def template(self, group_id: int) -> str:
        return next(c.get_template() for c in self.miner.drain.clusters if c.cluster_id == group_id)

    @property
    def templates(self) -> dict[int, str]:
        return {c.cluster_id: c.get_template() for c in self.miner.drain.clusters}


def grouping_accuracy(truth: Sequence[str], predicted: Sequence[int]) -> float:
    """Share of lines whose predicted group contains exactly the lines of their true template.

    The standard log-parsing metric (Zhu et al., ICSE-SEIP 2019): a group only counts if it is
    neither merged with another template nor split into several groups.
    """
    if len(truth) != len(predicted):
        raise ValueError("truth and predicted must have the same length")
    truth_sizes = Counter(truth)
    members: dict[int, list[str]] = {}
    for true_template, group in zip(truth, predicted, strict=True):
        members.setdefault(group, []).append(true_template)
    correct = sum(
        len(templates)
        for templates in members.values()
        if len(set(templates)) == 1 and truth_sizes[templates[0]] == len(templates)
    )
    return correct / len(truth) if truth else float("nan")
