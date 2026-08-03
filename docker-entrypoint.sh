#!/bin/sh
set -e

# 마이그레이션을 기동 시점에 적용한다.
#
# 별도 잡으로 빼는 편이 정석이지만, 그러려면 배포 파이프라인이 순서를 보장해야 한다.
# prisma migrate deploy 는 이미 적용된 마이그레이션을 건너뛰고 잠금을 잡으므로,
# 여러 인스턴스가 동시에 떠도 한 번만 실행된다.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] 마이그레이션 적용 중…"
  ./node_modules/.bin/prisma migrate deploy
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] 시드 실행 중…"
  ./node_modules/.bin/prisma db seed
fi

echo "[entrypoint] 서버 시작"
exec "$@"
