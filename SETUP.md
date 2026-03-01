# Cloudflare AI 자막 추출 시스템 설정 가이드

본 시스템을 배포하기 전에 Cloudflare 계정에서 다음 리소스들을 수동으로 생성하고 설정해야 합니다.

## 1. Cloudflare 리소스 생성

터미널에서 다음 명령어들을 순차적으로 실행하세요 (wrangler가 설치되어 있어야 합니다).

### 1.1. D1 데이터베이스 생성
```bash
npx wrangler d1 create subtitle_db
```
- 실행 후 출력되는 `database_id`를 복사하여 `wrangler.toml` 파일의 28라인에 붙여넣으세요.
- 예: `database_id = "your-new-db-id-here"`

### 1.2. Queue 생성
```bash
npx wrangler queues create subtitle-queue
```

## 2. GitHub Secrets 설정

GitHub 리포지토리의 `Settings > Secrets and variables > Actions` 메뉴에서 다음 값들을 등록하세요.

- `CF_API_TOKEN`: Cloudflare API 토큰 (Workers, D1, R2, Queues 편집 권한 필요)
- `CF_ACCOUNT_ID`: Cloudflare 계정 ID

## 3. 배포

위 설정이 완료된 후 코드를 `main` 브랜치에 푸시하면 GitHub Actions가 자동으로 다음 작업을 수행합니다.
1. D1 데이터베이스 스키마 적용 (`schema.sql`)
2. Worker 배포

## 4. 테스트
배포 완료 후 `test_subtitle.sh` 스크립트를 사용하여 시스템이 정상 동작하는지 테스트할 수 있습니다.
(파일 내 `WORKER_URL`을 본인의 Worker 주소로 수정 후 실행)
