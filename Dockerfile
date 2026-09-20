# syntax=docker/dockerfile:1.7

# 构建上下文是 uvp-eth 伞仓根：service 的 workspace:* 依赖
# （@uvp-eth/compiler 等）与 pnpm-lock 只在伞仓布局下可解析，本仓单独
# 无法安装。进入上下文的最小文件集由本仓 Dockerfile.dockerignore 的
# allowlist 圈定；构建入口在 uvp-deploy 的 project.sh image
# （scripts/lib/image.sh），UVP_FFI_GIT_REV/UVP_CORE_REF 由构建方按
# 工作区 uvp-core 检出显式注入。

FROM node:22-bookworm-slim AS builder

# uvp-node 原生模块在容器内从源码编译（预编译产物与平台绑定，不可随
# 仓携带）：Rust 版本跟随 uvp-core 的 rust-toolchain.toml，构建时 cargo
# 以该文件为准确认工具链，镜像内预装同一版本避免每次构建联网装链。
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --default-toolchain 1.96.0 -c rustfmt -c clippy
ENV PATH=/root/.cargo/bin:${PATH}

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# 容器内无 .git：不注入 UVP_FFI_GIT_REV（uvp-core 内容树 rev）时，
# uvp-node 的 build.rs 会把构建指纹降级成 no-git-*，TS 宿主的指纹门在
# 运行期直接拒载该产物——这里前置红掉，不让坏镜像成型。
ARG UVP_FFI_GIT_REV
RUN test -n "${UVP_FFI_GIT_REV}"

WORKDIR /ws

# 先落 workspace 清单与依赖包源码，再以伞仓 lockfile 为冻结基准安装
# chain-services 的依赖闭包。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY uvp-protocol/packages uvp-protocol/packages
COPY uvp-core/rust-toolchain.toml uvp-core/Cargo.toml uvp-core/Cargo.lock uvp-core/
COPY uvp-core/crates uvp-core/crates
COPY uvp-chain-services uvp-chain-services

RUN pnpm install --frozen-lockfile --filter @uvp-eth/chain-services...

RUN UVP_FFI_GIT_REV="${UVP_FFI_GIT_REV}" pnpm --filter @conucleus/uvp-core-node run build:release
RUN pnpm --filter @uvp-eth/chain-services run build

FROM node:22-bookworm-slim AS runtime

ARG UVP_CORE_REF
LABEL com.conucleus.dependencies.uvp-core-ref="${UVP_CORE_REF}"

RUN groupadd -r app && useradd -r -g app app

# 运行期迁移目录按进程 cwd 解析（migrations/、migrations/postgres/），
# 工作目录固定在 service 目录。
WORKDIR /ws/uvp-chain-services/service

# 只携带运行所需：node_modules（含 workspace 依赖的符号链接布局）、
# 源码与迁移；builder 的 Rust target 与 pnpm store 不进运行镜像。
COPY --from=builder --chown=app:app /ws/package.json /ws/pnpm-workspace.yaml /ws/pnpm-lock.yaml /ws/
COPY --from=builder --chown=app:app /ws/node_modules /ws/node_modules
COPY --from=builder --chown=app:app /ws/uvp-protocol /ws/uvp-protocol
COPY --from=builder --chown=app:app /ws/uvp-core/crates/uvp-node /ws/uvp-core/crates/uvp-node
COPY --from=builder --chown=app:app /ws/uvp-chain-services /ws/uvp-chain-services

# 原生模块缺失的镜像必然在运行期加载处失败：成型前红掉。
RUN test -s /ws/uvp-core/crates/uvp-node/uvp_node.node

ENV NODE_ENV=production
USER app

# 依赖包以 TS 源码为发布面（package.json exports 指向 src/*.ts），运行
# 走 tsx 即时转译，不依赖 builder 的 dist。镜像含 api 与 indexer 两个
# 运行角色，启动命令由部署方按环境模板显式指定，不设默认 CMD：
#   api:     node_modules/.bin/tsx src/api/server.ts
#   indexer: node_modules/.bin/tsx src/indexer/service.ts
