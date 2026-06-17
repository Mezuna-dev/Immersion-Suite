"""Single source of truth for the application version.

Keep this in sync with installer/ImmersionSuite_Setup.iss (#define AppVersion)
and extension/manifest.json on each release. The in-app updater compares this
value against the latest GitHub release tag.
"""

__version__ = "1.4.2"
