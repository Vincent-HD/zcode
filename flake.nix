{
  description = "Linux T3 Code fork packaged with its pinned upstream AppImage runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      zCode = import ./nix/default.nix { inherit pkgs self; };
    in
    {
      packages.${system} = {
        default = zCode;
        z-code = zCode;
        zcode = zCode;
        t3code = zCode;
      };

      apps.${system} = {
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
      };
    };
}
