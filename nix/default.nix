{ pkgs, self }:

let
  version = "0.1.8-nightly.20261105.4218";
  appImageHash = "sha256-aR9Bv6AR8Zf7eTXnn4n7NNVZW5bT8nSWLw3+sEX61/0=";
  upstreamSourceHash = "sha256-YMYvwC41yyEyHhIXqXXeAZ2nb3IRVJRvfM7x1hF24sw=";
  pnpmDepsHash = "sha256-xn0J3rYJ+LwpsBtTwsSp2wfdqTWRvldFUWx9X9n+ey8=";
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
