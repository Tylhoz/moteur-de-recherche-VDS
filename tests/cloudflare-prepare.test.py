"""Offline tests; no Cloudflare requests and no production information."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("cloudflare_prepare", Path(__file__).resolve().parents[1] / "scripts/cloudflare-prepare.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ACCOUNT = "a" * 32
BASE = "/accounts/" + ACCOUNT
OWNER = "owner@example.test"
APP_ID = "11111111-1111-4111-8111-111111111111"
OTP_ID = "22222222-2222-4222-8222-222222222222"
AUD = "b" * 64


def application():
    return {"id": APP_ID, "type": "self_hosted", "name": MODULE.APP_NAME,
            "domain": MODULE.HOST, "destinations": [{"type": "public", "uri": MODULE.HOST}],
            "allowed_idps": [OTP_ID], "aud": AUD}


def policy():
    return {"decision": "allow", "include": [{"email": {"email": OWNER}}], "require": [], "exclude": []}


class FakeCloudflare:
    def __init__(self, existing=False):
        bucket = BASE + "/r2/buckets/" + MODULE.BUCKET
        self.data = {
            bucket: {"name": MODULE.BUCKET},
            bucket + "/domains/managed": {"enabled": False},
            bucket + "/domains/custom": {"domains": []},
            BASE + "/access/organizations": {"auth_domain": "example.cloudflareaccess.com"},
            BASE + "/access/identity_providers": [{"id": OTP_ID, "type": "onetimepin"}],
            BASE + "/access/apps": [application()] if existing else [],
            BASE + "/access/apps/" + APP_ID: application(),
            BASE + "/access/apps/" + APP_ID + "/policies": [policy()],
        }
        self.writes = []
        self.reads = []

    def get(self, path):
        self.reads.append(path)
        return copy.deepcopy(self.data[path])

    def all(self, path):
        return self.get(path)

    def request(self, method, path, body=None):
        self.writes.append((method, path, copy.deepcopy(body)))
        if method != "POST" or path != BASE + "/access/apps":
            raise AssertionError("Mutation outside the single allowed Access creation")
        self.data[BASE + "/access/apps"] = [application()]
        return {"success": True, "result": {"id": APP_ID}}


class PreparationTests(unittest.TestCase):
    def test_default_plan_only_reads_and_does_not_invent_audience(self):
        api = FakeCloudflare()
        result, variables = MODULE.inspect_and_prepare(api, ACCOUNT, OWNER)
        self.assertEqual(result["accessApplication"], "creation_required")
        self.assertIsNone(variables)
        self.assertEqual(api.writes, [])
        self.assertFalse(result["deployed"])

    def test_apply_creates_exact_host_owner_policy_then_reads_back(self):
        api = FakeCloudflare()
        result, variables = MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(result["accessApplication"], "created_and_verified")
        self.assertEqual(len(api.writes), 1)
        body = api.writes[0][2]
        self.assertEqual(body["domain"], MODULE.HOST)
        self.assertEqual(body["policies"][0]["include"], [{"email": {"email": OWNER}}])
        self.assertIn(BASE + "/access/apps/" + APP_ID + "/policies", api.reads)
        self.assertEqual(variables["VDS_ACCESS_AUD"], AUD)
        self.assertFalse(result["dataImported"])

    def test_existing_correct_application_never_mutated(self):
        api = FakeCloudflare(existing=True)
        result, _ = MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(result["accessApplication"], "existing_and_verified")
        self.assertEqual(api.writes, [])

    def test_existing_broad_policy_blocks_without_repairing(self):
        api = FakeCloudflare(existing=True)
        api.data[BASE + "/access/apps/" + APP_ID + "/policies"][0]["include"] = [{"everyone": {}}]
        with self.assertRaisesRegex(MODULE.PreparationError, "policies_require_review"):
            MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(api.writes, [])

    def test_existing_bypass_blocks(self):
        api = FakeCloudflare(existing=True)
        api.data[BASE + "/access/apps/" + APP_ID + "/policies"][0]["decision"] = "bypass"
        with self.assertRaisesRegex(MODULE.PreparationError, "policies_require_review"):
            MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(api.writes, [])

    def test_mixed_destination_cannot_be_mistaken_for_dedicated_application(self):
        api = FakeCloudflare(existing=True)
        api.data[BASE + "/access/apps/" + APP_ID]["destinations"].append(
            {"type": "worker", "worker_id": "existing-worker"})
        with self.assertRaisesRegex(MODULE.PreparationError, "scope_requires_review"):
            MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(api.writes, [])

    def test_old_application_is_not_changed(self):
        api = FakeCloudflare()
        old = application()
        old.update({"name": "Existing portal", "domain": "moteur-de-recherche-vds.meert-val.workers.dev",
                    "destinations": []})
        api.data[BASE + "/access/apps"] = [old]
        MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0][1], BASE + "/access/apps")
        self.assertNotEqual(api.writes[0][2]["domain"], old["domain"])

    def test_wildcard_or_path_overlap_blocks_creation(self):
        for domain in ("*.meert-val.workers.dev", MODULE.HOST + "/api"):
            api = FakeCloudflare()
            app = application()
            app.update({"domain": domain, "destinations": [{"type": "public", "uri": domain}]})
            api.data[BASE + "/access/apps"] = [app]
            api.data[BASE + "/access/apps/" + APP_ID] = app
            with self.assertRaisesRegex(MODULE.PreparationError, "scope_requires_review"):
                MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
            self.assertEqual(api.writes, [])

    def test_public_bucket_blocks_before_any_access_creation(self):
        for kind in ("managed", "custom"):
            api = FakeCloudflare()
            path = BASE + "/r2/buckets/" + MODULE.BUCKET + "/domains/" + kind
            api.data[path] = {"enabled": True} if kind == "managed" else {"domains": [{"enabled": True}]}
            with self.assertRaises(MODULE.PreparationError):
                MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
            self.assertEqual(api.writes, [])

    def test_missing_otp_never_creates_identity_provider(self):
        api = FakeCloudflare()
        api.data[BASE + "/access/identity_providers"] = []
        with self.assertRaisesRegex(MODULE.PreparationError, "existing_email_login_required"):
            MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)
        self.assertEqual(api.writes, [])

    def test_response_drift_after_create_is_not_claimed_verified(self):
        api = FakeCloudflare()
        api.data[BASE + "/access/apps/" + APP_ID + "/policies"] = []
        with self.assertRaisesRegex(MODULE.PreparationError, "policies_require_review"):
            MODULE.inspect_and_prepare(api, ACCOUNT, OWNER, apply=True)

    def test_private_export_is_0600_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            path = MODULE.output_path(str(Path(directory) / "access.private.json"))
            MODULE.write_variables(path, {"VDS_ACCESS_AUD": AUD})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text())["VDS_ACCESS_AUD"], AUD)
            with self.assertRaises(MODULE.PreparationError):
                MODULE.output_path(str(path))
            with self.assertRaises(FileExistsError):
                MODULE.write_variables(path, {})

    def test_export_cannot_enter_repository_or_follow_symlink(self):
        with self.assertRaisesRegex(MODULE.PreparationError, "outside_repository"):
            MODULE.output_path(str(MODULE.ROOT / "should-not-exist.private.json"))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "data"
            target.write_text("preserve")
            link = Path(directory) / "link"
            link.symlink_to(target)
            with self.assertRaises(MODULE.PreparationError):
                MODULE.output_path(str(link))

    def test_missing_credentials_do_not_start_network_or_echo_email(self):
        from contextlib import redirect_stdout
        from io import StringIO
        output = StringIO()
        with patch.dict(os.environ, {"VDS_OWNER_EMAIL": OWNER}, clear=True), patch.object(MODULE.Cloudflare, "request") as request, redirect_stdout(output):
            code = MODULE.main([])
        self.assertEqual(code, 1)
        self.assertNotIn(OWNER, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["error"], "cloudflare_api_token_required")
        request.assert_not_called()

    def test_redirects_never_forward_bearer_credential(self):
        with self.assertRaisesRegex(MODULE.PreparationError, "redirect_refused"):
            MODULE.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example/")


if __name__ == "__main__":
    unittest.main()
