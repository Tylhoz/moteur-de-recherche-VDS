#!/usr/bin/env python3
"""Inspect private hosting; optionally create only its missing Access application.

Default: remote reads only. --apply creates one exact owner-only application if
absent, then re-reads its configuration. No Worker, bucket, identity provider,
secret, dataset, or existing Access application is ever modified.

Credentials are supplied by the environment, never command-line arguments.
Optional --output writes the three Access variables to a new 0600 JSON file
outside the repository (usable later with `wrangler secret bulk`).

Required account-scoped token permissions:
  Workers R2 Storage Read
  Access: Organizations, Identity Providers, and Groups Read
  Access: Apps and Policies Read (Write for --apply)

Official API references:
https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/
https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/list/
https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/
"""

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

API = "https://api.cloudflare.com/client/v4"
HOST = "moteur-de-recherche-vds-prive.meert-val.workers.dev"
BUCKET = "vds-intelligence-360-private"
APP_NAME = "VDS Intelligence 360 - Private"
ROOT = Path(__file__).resolve().parent.parent
UUID = re.compile(r"^[0-9a-f-]{36}$")


class PreparationError(Exception):
    """Only fixed, non-sensitive error codes may reach stdout."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PreparationError("api_redirect_refused")


class Cloudflare:
    def __init__(self, token):
        if not token or any(c in token for c in "\r\n"):
            raise PreparationError("cloudflare_api_token_required")
        self.token = token
        # build_opener installs ProxyHandler using inherited HTTP(S)_PROXY.
        # Standard TLS verification and configured CA trust are preserved.
        self.opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        if not path.startswith("/accounts/") or "://" in path:
            raise PreparationError("api_path_refused")
        raw = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(API + path, data=raw, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "User-Agent": "vds-private-preparation/1",
        })
        try:
            with self.opener.open(request, timeout=25) as response:
                data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise PreparationError("api_response_too_large")
            payload = json.loads(data)
        except HTTPError as error:
            # Do not echo Cloudflare responses, request headers, or tokens.
            raise PreparationError("cloudflare_http_" + str(error.code)) from None
        except (URLError, TimeoutError, OSError):
            raise PreparationError("cloudflare_network_unavailable") from None
        except (ValueError, UnicodeError):
            raise PreparationError("cloudflare_invalid_response") from None
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise PreparationError("cloudflare_request_unsuccessful")
        return payload

    def get(self, path):
        return self.request("GET", path).get("result")

    def all(self, path):
        result = []
        for page in range(1, 101):
            payload = self.request("GET", path + "?per_page=100&page=" + str(page))
            entries = payload.get("result")
            if not isinstance(entries, list):
                raise PreparationError("cloudflare_list_invalid")
            result.extend(entries)
            total = (payload.get("result_info") or {}).get("total_pages")
            if isinstance(total, int) and page >= total or total is None and len(entries) < 100:
                return result
        raise PreparationError("cloudflare_pagination_incomplete")


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise PreparationError("cloudflare_identifier_invalid")
    return value


def owner_email(value):
    if not isinstance(value, str) or len(value) > 319 or not re.fullmatch(r"[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+", value):
        raise PreparationError("owner_email_required")
    return value.lower()


def app_hosts(app):
    destinations = app.get("destinations")
    if destinations:
        if not isinstance(destinations, list):
            raise PreparationError("access_destinations_invalid")
        hosts = []
        for destination in destinations:
            if not isinstance(destination, dict):
                raise PreparationError("access_destinations_invalid")
            kind = destination.get("type")
            if kind in ("all_workers", "all_preview_workers"):
                raise PreparationError("account_wide_access_requires_review")
            if kind == "public":
                if destination.get("overrides"):
                    raise PreparationError("public_access_overrides_require_review")
                hosts.append(destination.get("uri", ""))
        return hosts
    domains = app.get("self_hosted_domains")
    if domains:
        if not isinstance(domains, list):
            raise PreparationError("access_destinations_invalid")
        return domains
    return [app.get("domain", "")]


def related_app(app):
    hosts = app_hosts(app)
    for host in hosts:
        if not isinstance(host, str):
            raise PreparationError("access_destinations_invalid")
        domain = host.split("/", 1)[0]
        if domain == HOST or fnmatch.fnmatchcase(HOST, domain):
            return True
    return app.get("name") == APP_NAME


def validate_app(app, policies, owner, otp_id):
    if not isinstance(app, dict) or app.get("type") != "self_hosted":
        raise PreparationError("access_application_type_requires_review")
    destinations = app.get("destinations")
    if destinations and (not isinstance(destinations, list) or len(destinations) != 1
                         or not isinstance(destinations[0], dict)
                         or destinations[0].get("type") != "public"
                         or destinations[0].get("uri") != HOST or destinations[0].get("overrides")):
        raise PreparationError("access_application_scope_requires_review")
    if app_hosts(app) != [HOST] or app.get("domain") not in (None, "", HOST):
        raise PreparationError("access_application_scope_requires_review")
    if app.get("allow_authenticate_via_warp") or app.get("allowed_idps") != [otp_id]:
        raise PreparationError("access_login_method_requires_review")
    if not isinstance(policies, list) or len(policies) != 1:
        raise PreparationError("access_policies_require_review")
    policy = policies[0]
    if not isinstance(policy, dict) or policy.get("decision") != "allow":
        raise PreparationError("access_policies_require_review")
    expected = [{"email": {"email": owner}}]
    if policy.get("include") != expected or policy.get("exclude") or policy.get("require"):
        raise PreparationError("access_policies_require_review")
    audience = app.get("aud")
    if not isinstance(audience, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", audience):
        raise PreparationError("access_audience_unavailable")
    return audience


def inspect_and_prepare(api, account, owner, apply=False):
    if not re.fullmatch(r"[a-f0-9]{32}", account or ""):
        raise PreparationError("cloudflare_account_id_required")
    owner = owner_email(owner)
    base = "/accounts/" + account
    bucket_base = base + "/r2/buckets/" + BUCKET
    bucket = api.get(bucket_base)
    if not isinstance(bucket, dict) or bucket.get("name") != BUCKET:
        raise PreparationError("existing_private_bucket_not_verified")
    managed = api.get(bucket_base + "/domains/managed")
    custom = api.get(bucket_base + "/domains/custom")
    if not isinstance(managed, dict) or managed.get("enabled") is not False:
        raise PreparationError("r2_public_access_not_disabled")
    if not isinstance(custom, dict) or not isinstance(custom.get("domains"), list):
        raise PreparationError("r2_custom_domains_not_verified")
    if any(not isinstance(domain, dict) or domain.get("enabled") is not False for domain in custom["domains"]):
        raise PreparationError("r2_custom_domain_not_disabled")
    organization = api.get(base + "/access/organizations")
    domain = organization.get("auth_domain") if isinstance(organization, dict) else None
    if not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com", domain):
        raise PreparationError("access_team_domain_unavailable")
    providers = api.all(base + "/access/identity_providers")
    otp = [p for p in providers if isinstance(p, dict) and p.get("type") == "onetimepin"]
    if len(otp) != 1:
        raise PreparationError("existing_email_login_required")
    otp_id = identifier(otp[0].get("id"))
    apps = api.all(base + "/access/apps")
    if any(not isinstance(app, dict) for app in apps):
        raise PreparationError("access_applications_invalid")
    related = [app for app in apps if related_app(app)]
    if len(related) > 1:
        raise PreparationError("overlapping_access_applications_require_review")
    created = False
    if not related and not apply:
        return {"mode": "plan", "bucketPrivateVerified": True, "existingEmailLoginVerified": True,
                "accessApplication": "creation_required", "deployed": False, "dataImported": False}, None
    if not related:
        body = {"name": APP_NAME, "type": "self_hosted", "domain": HOST,
                "destinations": [{"type": "public", "uri": HOST}],
                "allowed_idps": [otp_id], "session_duration": "8h",
                "allow_authenticate_via_warp": False,
                "policies": [{"name": "VDS owner only", "decision": "allow", "precedence": 1,
                              "include": [{"email": {"email": owner}}], "exclude": [], "require": []}]}
        # This is the sole remote mutation in this script. Existing apps are never updated.
        response = api.request("POST", base + "/access/apps", body).get("result")
        app_id = identifier(response.get("id") if isinstance(response, dict) else None)
        created = True
    else:
        app_id = identifier(related[0].get("id"))
    # Fresh reads verify server state; POST success alone is not a verification.
    application = api.get(base + "/access/apps/" + app_id)
    policies = api.all(base + "/access/apps/" + app_id + "/policies")
    audience = validate_app(application, policies, owner, otp_id)
    variables = {"VDS_ACCESS_TEAM_DOMAIN": "https://" + domain,
                 "VDS_ACCESS_AUD": audience, "VDS_OWNER_EMAIL": owner}
    return {"mode": "apply" if apply else "plan", "bucketPrivateVerified": True,
            "existingEmailLoginVerified": True, "accessApplication": "created_and_verified" if created else "existing_and_verified",
            "deployed": False, "dataImported": False}, variables


def output_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or path.is_symlink():
        raise PreparationError("private_output_path_required")
    path = path.resolve()
    if path == ROOT or ROOT in path.parents:
        raise PreparationError("output_must_be_outside_repository")
    if not path.parent.is_dir() or stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        raise PreparationError("private_output_directory_0700_required")
    if path.exists():
        raise PreparationError("output_already_exists")
    return path


def write_variables(path, variables):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(variables, handle, ensure_ascii=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Create only a missing, dedicated owner-only Access application.")
    parser.add_argument("--output", help="New absolute 0600 JSON file outside this repository, in an existing 0700 directory.")
    args = parser.parse_args(argv)
    try:
        path = output_path(args.output) if args.output else None
        if args.apply and path is None:
            raise PreparationError("private_output_required_for_apply")
        api = Cloudflare(os.environ.get("CLOUDFLARE_API_TOKEN"))
        summary, variables = inspect_and_prepare(api, os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
                                                os.environ.get("VDS_OWNER_EMAIL"), apply=args.apply)
        if path and variables:
            write_variables(path, variables)
            summary["privateVariablesWritten"] = True
        print(json.dumps(summary))
        return 0
    except PreparationError as error:
        print(json.dumps({"ok": False, "error": str(error), "deployed": False, "dataImported": False}))
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"ok": False, "error": "preparation_failed", "deployed": False, "dataImported": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
