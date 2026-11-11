{
  description = "T3 Code fork packaged with its pinned upstream desktop runtime for Linux and macOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forEachSystem =
        mkOutput:
        nixpkgs.lib.genAttrs systems (
          system:
          mkOutput (
            import ./nix/default.nix {
              pkgs = import nixpkgs { inherit system; };
              inherit self;
            }
          )
        );
    in
    {
      packages = forEachSystem (zCode: {
        default = zCode;
        z-code = zCode;
        zcode = zCode;
        t3code = zCode;
      });

      apps = forEachSystem (zCode: {
        z-code = {
          type = "app";
          program = "${zCode}/bin/z-code";
        };
        zcode = {
          type = "app";
          program = "${zCode}/bin/zcode";
        };
        t3code = {
          type = "app";
          program = "${zCode}/bin/t3code";
        };
      });
    };
}
