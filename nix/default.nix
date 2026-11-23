{ pkgs, self }:

let
  version = "0.1.12-nightly.20261123.5124";
  appImageHash = "sha256-SA2zfxFR08kUcybFQnzz+SsTKMJX4hU9TMhgAC+vCFQ=";
  macZipHash = "sha256-Z+oieHCrx6inAzWjBcS9UGs0vEZ8BhLadg4gJZgDG8A=";
  upstreamSourceHash = "sha256-H1rTj2Pb1nOolqbQYZQFlWILl++kyv887zgtxcVV6dw=";
  pnpmDepsHash = "sha256-fBJPoV6wd+uLApQnN84MVk91wgExj1EI4IAvyog7cFQ=";
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
# The renderer and server are platform-independent JavaScript; only the upstream
# Electron runtime that carries them differs between Linux and macOS.
if pkgs.stdenv.hostPlatform.isDarwin then
  pkgs.callPackage ./z-code-darwin.nix {
    inherit
      version
      macZipHash
      upstreamSourceHash
      rendererServer
      ;
  }
else
  pkgs.callPackage ./z-code.nix {
    inherit
      version
      appImageHash
      upstreamSourceHash
      rendererServer
      ;
  }
