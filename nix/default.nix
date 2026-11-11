{ pkgs, self }:

let
  version = "0.1.9-nightly.20261110.4478";
  appImageHash = "sha256-A0uSaodJzrk3og46OEt+WMPQZo3A9Qicxr0MfEVFCfk=";
  macZipHash = "sha256-NuF0Gkvx9Q78/BGSnfS7GnyBtciU8PTSmvUkKkfIEBM=";
  upstreamSourceHash = "sha256-OndvJTIizud5+pGSZWTSFHeFwcIOztT0v/W1dqZjqt0=";
  pnpmDepsHash = "sha256-89bapDdjYQXsQ7bV7HFxn5W8kanNALDxGjt+xSvJS/4=";
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
