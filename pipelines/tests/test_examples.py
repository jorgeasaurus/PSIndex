"""The shared docs helpers (examples, syntax, synopsis) and the parsers that use them, on small local docs samples.

Run with: python3 -m unittest discover -s pipelines/tests
"""
import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PIPELINES = Path(__file__).resolve().parent.parent
SAMPLES = Path(__file__).resolve().parent / "samples"
sys.path.insert(0, str(PIPELINES))

from common import clean_synopsis, examples_from, syntax_from  # noqa: E402


def parser(source):
    """pipelines/<source>/parse_docs.py as a module (the parsers are scripts, not a package)."""
    spec = importlib.util.spec_from_file_location(f"{source}_parse_docs", PIPELINES / source / "parse_docs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Both samples hold more PowerShell examples than the default limit of 3, so a parser that
# loses its limit, or slices or drops examples, changes its result.
AZ_EXAMPLES = [
    'New-AzThing -Name "one"',
    '<#\nSettings for the thing:\n[ { "name": "two" } ]\n#>\n# set the resource group\n$rg = "x"\nNew-AzThing -Name "two" # inline note',
    'New-AzThing -Name "four"',
]
AZ_SYNTAX = (
    "New-AzThing -Name <String> [-DefaultProfile <IAzureContextContainer>]\n\n"
    "New-AzThing -InputObject <PSThing> [-DefaultProfile <IAzureContextContainer>]"
)
ENTRA_EXAMPLES = [
    "Connect-Entra -Scopes 'User.Read.All'\nGet-EntraThing -Top 3",
    "Get-EntraThing -ThingId 'x'",
    "Get-EntraThing -ThingId 'y'",
]
ENTRA_SYNTAX = "Get-EntraThing [-Top <Int32>] [<CommonParameters>]\n\nGet-EntraThing -ThingId <String> [<CommonParameters>]"


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

    def test_default_limit_is_three(self):
        section = "".join(f"```\nGet-X{i}\n```\n" for i in range(5))
        self.assertEqual(examples_from(section), ["Get-X0", "Get-X1", "Get-X2"])

    def test_unclosed_fence_runs_to_the_section_end(self):
        section = "```powershell\nGet-X\n```\n\n```powershell\nGet-Unclosed\n"
        self.assertEqual(examples_from(section), ["Get-X", "Get-Unclosed"])

    def test_prompts_removed(self):
        section = "```\nPS> Get-A\nPS>Get-B\nPS C:\\> Get-C\nPS /home/user> Get-D\nPSObject> kept\n```\n"
        self.assertEqual(examples_from(section), ["Get-A\nGet-B\nGet-C\nGet-D\nPSObject> kept"])


class SyntaxFrom(unittest.TestCase):
    def test_every_parameter_set_without_comments(self):
        section = "### A\n```\nGet-X -A\n```\n\n### B\n```\n# ParameterSetName: B\nGet-X -B\n```\n\n### C\n```\nGet-X -C\n```\n"
        self.assertEqual(syntax_from(section), "Get-X -A\n\nGet-X -B\n\nGet-X -C")


class CleanSynopsis(unittest.TestCase):
    def test_emphasis_code_and_links_lose_their_markup(self):
        line = "Gets a *thing* from **all** _sites_ with `-Sku` and __more__, see [the docs](https://x/y)."
        self.assertEqual(clean_synopsis(line), "Gets a thing from all sites with -Sku and more, see the docs.")

    def test_underscores_and_stars_in_text_kept(self):
        line = "Upgrade from Standard_AzureFrontDoor to Premium\\_AzureFrontDoor for user_name, 2 * 3, Get-* cmdlets."
        self.assertEqual(clean_synopsis(line), "Upgrade from Standard_AzureFrontDoor to Premium_AzureFrontDoor for user_name, 2 * 3, Get-* cmdlets.")


class ExchangeCategory(unittest.TestCase):
    def test_client_access_nouns_before_mailbox(self):
        category = parser("exchange").get_exchange_category
        for name in ("Get-CASMailbox", "Set-CASMailbox", "Get-CASMailboxPlan", "New-OwaMailboxPolicy", "Set-ActiveSyncMailboxPolicy", "Get-ActiveSyncDevice"):
            self.assertEqual(category(name), "Client Access", name)
        for name in ("Get-Mailbox", "Set-MailboxFolderPermission"):
            self.assertEqual(category(name), "Mailbox Management", name)


class Parsers(unittest.TestCase):
    def test_az(self):
        result = parser("az").parse_cmdlet_doc(SAMPLES / "New-AzThing.md")
        self.assertEqual(result["examples"], AZ_EXAMPLES)
        self.assertEqual(result["syntax"], AZ_SYNTAX)

    def test_az_and_exchange_synopsis_keeps_identifiers(self):
        text = (SAMPLES / "New-AzThing.md").read_text(encoding="utf-8").replace(
            "Creates a thing.", "Upgrade from **Standard_AzureFrontDoor** using `-Sku` and user_name, 2 * 3.")
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "New-AzThing.md"
            doc.write_text(text, encoding="utf-8")
            results = [parser("az").parse_cmdlet_doc(doc), parser("exchange").parse_cmdlet_doc(doc, "Exchange", "ExchangePowerShell")]
        for result in results:
            self.assertEqual(result["description"], "Upgrade from Standard_AzureFrontDoor using -Sku and user_name, 2 * 3.")

    def test_exchange(self):
        result = parser("exchange").parse_cmdlet_doc(SAMPLES / "New-AzThing.md", "Exchange", "ExchangePowerShell")
        self.assertEqual(result["examples"], AZ_EXAMPLES)
        self.assertEqual(result["syntax"], AZ_SYNTAX)
        self.assertEqual(result["module"], "Az.Test")

    def test_exchange_module_without_front_matter_is_the_module_directory(self):
        result = parser("exchange").parse_cmdlet_doc(SAMPLES / "Get-EntraThing.md", "Skype for Business", "SkypeForBusiness")
        self.assertEqual(result["module"], "SkypeForBusiness")

    def test_entra(self):
        result = parser("entra").parse_cmdlet_file(SAMPLES / "Get-EntraThing.md", "Microsoft.Entra.Users", "v1.0")
        self.assertEqual(result["examples"], ENTRA_EXAMPLES)
        self.assertEqual(result["syntax"], ENTRA_SYNTAX)

    def test_graph(self):
        result = parser("graph").parse_cmdlet_file(SAMPLES / "Get-EntraThing.md", "Microsoft.Graph.Users", "v1.0")
        self.assertEqual(result["examples"], ENTRA_EXAMPLES)
        self.assertEqual(result["syntax"], ENTRA_SYNTAX)

    def test_mecm_has_no_limit(self):
        # MECM takes the cmdlet name from the file name, so the Az sample is read as New-CMThing.md.
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "New-CMThing.md"
            shutil.copyfile(SAMPLES / "New-AzThing.md", doc)
            result = parser("mecm").parse_cmdlet_file(doc)
        self.assertEqual(result["examples"], AZ_EXAMPLES + ['New-AzThing -Name "five"'])
        self.assertEqual(result["syntax"], AZ_SYNTAX)


if __name__ == "__main__":
    unittest.main()
