# Connecting a Google account (Tasks + Docs export)

MeetingNotes exports action items to **Google Tasks** and meetings to a
**Google Doc** using your own Google account. Because these write to *your*
personal data, Google requires a one-time OAuth sign-in — there's no API-key
shortcut.

MeetingNotes is local-first and isn't a Google-verified app, so you supply
your **own** OAuth client (free, ~10 minutes). This keeps everything under
your control: your project, your account, no shared quota, and tokens that
don't expire weekly.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. Top bar → project dropdown → **New Project**. Name it anything (e.g.
   "MeetingNotes"). Create, then select it.

## 2. Enable the APIs

In **APIs & Services → Library**, enable both:

- **Google Tasks API**
- **Google Drive API** (used to create the Google Doc)

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**:

1. User type: **External** → Create.
2. Fill in app name + your email where required. Save and continue.
3. **Scopes** → Add:
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.file`
4. **Test users** → add your own Google address.
5. Back on the consent-screen overview, **Publish app** → set Publishing
   status to **In production**.
   - This matters: in *Testing* status Google expires refresh tokens after 7
     days, so you'd have to re-sign-in weekly. In *Production* your sign-in
     lasts. You'll see a one-time "Google hasn't verified this app" screen —
     that's expected for your own app; click **Advanced → Go to … (unsafe)**
     to continue. (It's *your* app and *your* account.)

## 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

1. Application type: **Desktop app**.
2. Name it, Create.
3. Copy the **Client ID** and **Client Secret**.

## 5. Sign in from MeetingNotes

1. **Settings → Google account**.
2. Paste the Client ID and Client Secret.
3. Click **Sign in with Google**, approve in the browser that opens, and
   return to the app. You should see your connected email.

The **Google Tasks** and **Google Doc** export buttons in a meeting's Export
panel are now enabled.

## Notes

- **Google Tasks** receives only the action items assigned to **you** (set
  *Settings → "You are…"* so MeetingNotes knows which items are yours). The
  export panel shows a 🔒 reminder.
- **Google Doc** exports the full meeting (summary + all action items) into a
  "MeetingNotes" folder in your Drive and returns the Doc link.
- Your refresh token is stored **encrypted** via the macOS keychain
  (Electron `safeStorage`). The client secret for a Desktop OAuth client is
  non-confidential by Google's design.
- Disconnect any time with **Sign out** in Settings.
