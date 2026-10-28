{ pkgs, self }:

let
  version = "0.1.4-nightly.20261028.3824";
  appImageHash = "sha256-pP0mFbSUxj94y6ZYfSUUSUuqPWqQLwNZHs5lT39kc1M=";
  upstreamSourceHash = "sha256-ctK3H97PfVLYl+X7ZLic4A6jzjmmetK/AXzIEaLVDYQ=";
  pnpmDepsHash = "sha256-yfGmIplM2YP276PwCsgE61/NtUmyqeffH1eeQfvojps=";
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
