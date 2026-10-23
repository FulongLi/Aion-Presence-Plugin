#!/bin/sh
# Builds Elmer FEM (ElmerSolver, ElmerGrid) into a user-local prefix, without sudo and without a system package
# manager. Used on macOS (Apple Silicon tested) where Elmer has no binary release.
#
#   sh scripts/sim/build-elmer.sh            # installs into ~/.aion-sim/elmer
#   AION_SIM_HOME=/path sh scripts/sim/build-elmer.sh
#
# Steps: micromamba (one static binary from micro.mamba.pm) creates a private conda-forge toolchain
# (compilers, cmake, make, OpenBLAS); Elmer's official source (github.com/ElmerCSC/elmerfem) is cloned at a release
# tag and built serially (no MPI, no GUI, no Elmer/Ice). Aion finds the result at $AION_SIM_HOME/elmer/bin.
# Elmer is GPL software, built and run here as an independent program; Aion does not bundle it.
set -eu

ELMER_TAG="${ELMER_TAG:-release-26.2.1}"
HOME_DIR="${AION_SIM_HOME:-$HOME/.aion-sim}"
TOOLCHAIN="$HOME_DIR/toolchain"
PREFIX="$HOME_DIR/elmer"
SRC="$HOME_DIR/src/elmerfem"
BUILD="$HOME_DIR/src/build"
MAMBA="$HOME_DIR/bin/micromamba"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"

mkdir -p "$HOME_DIR/bin" "$HOME_DIR/src"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=osx-arm64 ;;
  Darwin-x86_64) PLATFORM=osx-64 ;;
  Linux-x86_64) PLATFORM=linux-64 ;;
  Linux-aarch64) PLATFORM=linux-aarch64 ;;
  *) echo "Unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

case "$(uname -s)" in Darwin) EXT=dylib ;; *) EXT=so ;; esac

if [ ! -x "$MAMBA" ]; then
  echo "==> micromamba ($PLATFORM)"
  curl -fsSL "https://micro.mamba.pm/api/micromamba/$PLATFORM/latest" | tar -xj -C "$HOME_DIR" bin/micromamba
fi

if [ ! -d "$TOOLCHAIN/conda-meta" ]; then
  echo "==> conda-forge toolchain"
  MAMBA_ROOT_PREFIX="$HOME_DIR/mamba" "$MAMBA" create -y -p "$TOOLCHAIN" -c conda-forge --override-channels \
    c-compiler cxx-compiler fortran-compiler cmake make libblas liblapack "libblas=*=*openblas"
fi

if [ ! -d "$SRC/.git" ]; then
  echo "==> Elmer source $ELMER_TAG"
  git clone --depth 1 --branch "$ELMER_TAG" https://github.com/ElmerCSC/elmerfem.git "$SRC"
fi

echo "==> configure"
rm -rf "$BUILD"
MAMBA_ROOT_PREFIX="$HOME_DIR/mamba" "$MAMBA" run -p "$TOOLCHAIN" cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_PREFIX_PATH="$TOOLCHAIN" -DUSE_MACOS_PACKAGE_MANAGER=FALSE \
  -DWITH_MPI=FALSE -DWITH_OpenMP=FALSE -DWITH_ELMERGUI=FALSE -DWITH_ElmerIce=FALSE -DWITH_LUA=FALSE \
  -DWITH_Mumps=FALSE -DWITH_Hypre=FALSE -DWITH_Trilinos=FALSE -DWITH_MMG=FALSE -DWITH_Zoltan=FALSE \
  -DBLAS_LIBRARIES="$TOOLCHAIN/lib/libblas.$EXT" -DLAPACK_LIBRARIES="$TOOLCHAIN/lib/liblapack.$EXT"

echo "==> build ($JOBS jobs)"
MAMBA_ROOT_PREFIX="$HOME_DIR/mamba" "$MAMBA" run -p "$TOOLCHAIN" cmake --build "$BUILD" -j "$JOBS"
MAMBA_ROOT_PREFIX="$HOME_DIR/mamba" "$MAMBA" run -p "$TOOLCHAIN" cmake --install "$BUILD"

echo "==> check"
"$PREFIX/bin/ElmerSolver" -v 2>&1 | head -5 || true
echo "Elmer installed in $PREFIX"
