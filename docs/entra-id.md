# Entra ID sign-in

Eagle Eye signs users in with OIDC against a dedicated Entra ID tenant and takes each user's access from Entra **app roles** (the `roles` claim in the ID token). App roles avoid the group-overage limit and do not need Entra ID P1 when users are assigned directly.

Role values use the same names as Keycloak groups: `casemgr-<tenant>-<grant>`, plus `casemgr-platform_admin`. Grants are the roles `admin`, `ir_lead`, `analyst`, `legal`, `executive`, `auditor` and the flags `restricted_case`, `malware:read`.

## 1. Tenant and MFA

1. Create a new workforce tenant (Entra admin center, Manage tenants, Create). Keep it separate from the corporate tenant.
2. MFA: new tenants have security defaults on, which require MFA registration and prompt for MFA. If you use Conditional Access instead (needs Entra ID P1), turn security defaults off and add a policy requiring MFA for the Eagle Eye app.
3. Create two cloud-only break-glass Global Administrator accounts on the `onmicrosoft.com` domain, protected with FIDO2 keys, excluded from Conditional Access, with credentials stored offline and an alert on every sign-in.

## 2. App registration

1. App registrations, New registration: name `Eagle Eye`, single tenant.
2. Redirect URIs (platform **Web**): `https://<host>/api/auth/callback` and `https://<host>` (the post-logout return address). For local development also add `http://localhost:8080/api/auth/callback` and `http://localhost:8080`.
3. Certificates & secrets: create a client secret. Store it as `CASEMGR_OIDC_CLIENT_SECRET` in Key Vault, never in Git. Record its expiry and rotate before it.
4. Token configuration: add the optional claim `email` to the ID token.
5. API permissions: Microsoft Graph delegated `openid`, `profile`, `email`, `offline_access`. Grant admin consent.
6. App roles: import `deploy/entra/app-roles.json` (17 roles for the `detect-respond` and `insider-threat` tenants). With the Azure CLI, signed in to the new tenant:

```powershell
az ad app update --id <application-client-id> --app-roles "@deploy/entra/app-roles.json"
```

The role IDs in the file are fixed, so re-running the command is safe. To remove a role later, disable it (`isEnabled: false`) and update before deleting it.

## 3. Assignments

1. Enterprise applications, Eagle Eye, Properties: set **Assignment required** to Yes, so unassigned users cannot sign in.
2. Users and groups: assign each user one or more roles. Combine a role with a flag where needed, for example `casemgr-insider-threat-analyst` and `casemgr-insider-threat-restricted_case`. Assigning groups instead of users needs Entra ID P1.

## 4. Eagle Eye settings

| Setting | Value |
|---|---|
| `CASEMGR_OIDC_METADATA_URL` | `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration` |
| `CASEMGR_OIDC_CLIENT_ID` | Application (client) ID |
| `CASEMGR_OIDC_SCOPE` | `openid profile email offline_access` (Entra issues refresh tokens only with `offline_access`) |
| `CASEMGR_OIDC_ROLES_CLAIM` | `roles` |
| `CASEMGR_OIDC_CLIENT_SECRET` | the client secret (secret store) |

In the Helm chart, the first four go under `config:` without the `CASEMGR_` prefix; the secret goes in the `casemgr` Secret.

## 5. How access changes take effect

- At sign-in, roles come from the ID token.
- Every `CASEMGR_GROUP_SYNC_MINUTES` (default 5) the backend redeems the refresh token, validates the new ID token's signature, issuer, and audience, and replaces the user's grants with its `roles` claim. Each change is audited as `grants.synced`.
- Removing an assignment therefore takes effect within the sync interval. If the refresh fails (user disabled, consent revoked, password reset that revokes tokens) or returns no ID token, the session ends.

## 6. Verification checklist

- [ ] A user with `casemgr-detect-respond-analyst` signs in with MFA, and `GET /api/me` lists only `detect-respond` with the analyst role.
- [ ] A user with no assignment is refused by Entra (assignment required).
- [ ] Removing the assignment removes the tenant from `GET /api/me` within the sync interval, and the audit log shows `grants.synced`.
- [ ] Logging out returns to `https://<host>` without an Entra error.
- [ ] Break-glass sign-ins raise an alert.
