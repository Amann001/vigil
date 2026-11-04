import pytest

from vigil.logparse import EXTENDED_MASKS, LogParser, grouping_accuracy


def test_lines_differing_only_in_parameters_share_a_group():
    parser = LogParser()

    groups = parser.parse(
        [
            "Connection to 10.0.0.5 failed after 3 retries",
            "Connection to 10.0.0.9 failed after 5 retries",
            "Disk usage at 91 percent on /dev/sda1",
        ]
    )

    assert groups[0] == groups[1] != groups[2]
    assert "<IP>" in parser.template(groups[0])
    assert "<NUM>" in parser.template(groups[0])


def test_hex_values_are_parameters():
    parser = LogParser()

    groups = parser.parse(["fault at 0x7ffe12ab in worker", "fault at 0x00aa0b10 in worker"])

    assert groups[0] == groups[1]


def test_extended_masks_hide_uuids_and_hostnames():
    parser = LogParser(masks=EXTENDED_MASKS)

    groups = parser.parse(
        [
            "[instance: 96abccce-8d1f-4e07-b6d1-4b2ab87e23b4] Claim successful",
            "[instance: b562ef10-ba2d-48ae-bf4a-18666cba4a51] Claim successful",
            "www.google.com:443 open through proxy",
            "mtalk.google.com:5228 open through proxy",
        ]
    )

    assert groups[0] == groups[1]
    assert groups[2] == groups[3]
    assert "<UUID>" in parser.template(groups[0])


def test_perfect_grouping_scores_one():
    assert grouping_accuracy(["A", "A", "B"], [7, 7, 9]) == 1.0


def test_merging_two_templates_fails_both():
    assert grouping_accuracy(["A", "A", "B"], [1, 1, 1]) == 0.0


def test_splitting_a_template_fails_it_but_not_others():
    assert grouping_accuracy(["A", "A", "B", "B"], [1, 2, 3, 3]) == 0.5


def test_lengths_must_match():
    with pytest.raises(ValueError):
        grouping_accuracy(["A"], [1, 2])
