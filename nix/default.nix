{ pkgs, self }:

let
  version = "0.1.3-nightly.20261027.3754";
  appImageHash = "sha256-ghUTlho/pFX6x/9r0w8vUrK6xqw7V4QCqPzvDA4sCUE=";
  upstreamSourceHash = "sha256-xxmwaHPkXzR0CAtknCc6raAzcnPtmw8wxF3YO3WcbE4=";
  pnpmDepsHash = "sha256-ttSt/i8ZNGTuDSTzdy8Cau2aa/26PwlrRbtZ7WKv3p0=";
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
