"""The shared example extractor and the parsers that use it, on small local docs samples.

Run with: python3 -m unittest discover -s pipelines/tests
"""
import importlib.util
import sys
import unittest
from pathlib import Path

PIPELINES = Path(__file__).resolve().parent.parent
SAMPLES = Path(__file__).resolve().parent / "samples"
sys.path.insert(0, str(PIPELINES))

from common import examples_from  # noqa: E402


def parser(source):
    """pipelines/<source>/parse_docs.py as a module (the parsers are scripts, not a package)."""
    spec = importlib.util.spec_from_file_location(f"{source}_parse_docs", PIPELINES / source / "parse_docs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AZ_EXAMPLES = [
    'New-AzThing -Name "one"',
    '<#\nSettings for the thing:\n[ { "name": "two" } ]\n#>\n# set the resource group\n$rg = "x"\nNew-AzThing -Name "two" # inline note',
    'New-AzThing -Name "four"',
]


class ExamplesFrom(unittest.TestCase):
    def test_output_block_closing_fence_opens_nothing(self):
        section = '```powershell\nGet-X\n```\n\n```Output\nName\n----\n```\n\nProse.\n\n### Example 2\n```powershell\nGet-Y\n```\n'
        self.assertEqual(examples_from(section), ["Get-X", "Get-Y"])

    def test_comments_and_block_comments_kept(self):
        section = '```powershell\n<#\nnote\n#>\n# set rg\n$rg = "x"\n```'
        self.assertEqual(examples_from(section), ['<#\nnote\n#>\n# set rg\n$rg = "x"'])

    def test_other_languages_skipped(self):
        section = '```json\n{}\n```\n```yaml\na: 1\n```\n```PowerShell\nGet-X\n```\n'
        self.assertEqual(examples_from(section), ["Get-X"])

    def test_longer_fence_holds_a_shorter_one(self):
        section = '````powershell\n$md = @"\n```\n"@\n````\n'
        self.assertEqual(examples_from(section), ['$md = @"\n```\n"@'])

    def test_limit(self):
        section = "".join(f"```\nGet-X{i}\n```\n" for i in range(5))
        self.assertEqual(examples_from(section, 3), ["Get-X0", "Get-X1", "Get-X2"])


class Parsers(unittest.TestCase):
    def test_az(self):
        result = parser("az").parse_cmdlet_doc(SAMPLES / "New-AzThing.md")
        self.assertEqual(result["examples"], AZ_EXAMPLES)

    def test_exchange(self):
        result = parser("exchange").parse_cmdlet_doc(SAMPLES / "New-AzThing.md", "Exchange", "ExchangePowerShell")
        self.assertEqual(result["examples"], AZ_EXAMPLES)
        self.assertEqual(result["module"], "Az.Test")

    def test_exchange_module_without_front_matter_is_the_module_directory(self):
        result = parser("exchange").parse_cmdlet_doc(SAMPLES / "Get-EntraThing.md", "Skype for Business", "SkypeForBusiness")
        self.assertEqual(result["module"], "SkypeForBusiness")

    def test_entra_and_graph(self):
        expected = ["Connect-Entra -Scopes 'User.Read.All'\nGet-EntraThing -Top 3", "Get-EntraThing -ThingId 'x'"]
        result = parser("entra").parse_cmdlet_file(SAMPLES / "Get-EntraThing.md", "Microsoft.Entra.Users", "v1.0")
        self.assertEqual(result["examples"], expected)
        graph = parser("graph")
        section = graph.extract_section((SAMPLES / "Get-EntraThing.md").read_text(encoding="utf-8"), "EXAMPLES")
        self.assertEqual(examples_from(section), expected)

    def test_mecm_has_no_limit(self):
        mecm = parser("mecm")
        _, body = mecm.parse_front_matter((SAMPLES / "New-AzThing.md").read_text(encoding="utf-8"))
        self.assertEqual(examples_from(mecm.parse_section(body, "EXAMPLES"), limit=None), AZ_EXAMPLES + ['New-AzThing -Name "five"'])


if __name__ == "__main__":
    unittest.main()
