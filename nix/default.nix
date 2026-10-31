{ pkgs, self }:

let
  version = "0.1.7-nightly.20261031.3991";
  appImageHash = "sha256-orO0UXpPKmc+cCCh5wbQePrIkcOj++5MMA6KPFGWkIk=";
  upstreamSourceHash = "sha256-aWyK6tu1if2k3MGJIVMF9NrfTgo8Cs1+fOg3Gb3C6Tg=";
  pnpmDepsHash = "sha256-JikGsXejgxFJ9QOpIl18Fh8DGog5SymUJk+9lo43XZ8=";
  spdxLicenseListVersion = "v3.28.0";
  spdxLicenseListRevision = "c4a7237ec8f4654e867546f9f409749300f1bf4c";

  upstreamSource = pkgs.fetchFromGitHub {
    owner = "pingdotgg";
    repo = "t3code";
    rev = "v${version}";
    hash = upstreamSourceHash;
  };

  spdxLicenseList = pkgs.fetchFromGitHub {
    owner = "spdx";
    repo = "license-list-data";
    rev = spdxLicenseListRevision;
    hash = "sha256-FbeeEBAg9ih6DkAsXdU6ruZwkC7A2u2zYBvblpl54q0=";
  };

  rendererServer = pkgs.callPackage ./renderer-server.nix {
    src = self;
    inherit
      version
      pnpmDepsHash
      upstreamSource
      spdxLicenseList
      spdxLicenseListVersion
      ;
  };
in
pkgs.callPackage ./z-code.nix {
  inherit
    version
    appImageHash
    upstreamSourceHash
    rendererServer
    ;
}
