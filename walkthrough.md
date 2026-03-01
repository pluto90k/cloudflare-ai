# Cloudflare AI 자막 추출 시스템 (TS List 비동기 방식)

어제 성공했던 **TS List 처리 방식(30초 청크 + 문맥 유지)**을 Cloudflare Queue와 D1을 활용한 비동기 아키텍처로 구현 완료했습니다.

## 1. 주요 구현 사항

1. **비동기 큐 처리**: `/process-ts` 호출 시 작업을 Queue에 등록하고 즉시 응답합니다.
2. **30초 청크 최적화**: 큐 워커에서 TS 파일들을 30초 단위(3개 세그먼트)로 묶어 처리하여 페이로드 에러를 방지합니다.
3. **문맥 유지 (Iterative Prompting)**: 이전 청크의 텍스트 결과를 다음 청크의 `initial_prompt`로 전달하여 문장의 연속성을 확보합니다.
4. **상태 관리**: D1 데이터베이스를 통해 작업 상태(`processing`, `completed`, `failed`)를 실시간으로 추적합니다.

## 2. 사용 방법

### 1단계: 작업 고유 ID 및 TS URL 리스트 준비
```json
{
  "jobId": "my-video-001",
  "tsUrls": [
    "https://example.com/seg1.ts",
    "https://example.com/seg2.ts",
    "https://example.com/seg3.ts"
  ],
  "language": "ko"
}
```

### 2단계: 작업 요청 (POST /process-ts)
```bash
curl -X POST "https://your-worker.workers.dev/process-ts" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

### 3단계: 상태 확인 및 결과 다운로드
- 상태 확인: `GET /status?jobId=my-video-001`
- VTT 다운로드: `GET /get-final-vtt?jobId=my-video-001`

## 3. 테스트 스크립트
`/Users/jooyoungkim/Develop/wecandeo/cloudflare-ai/test_subtitle.sh` 파일을 사용하여 전체 과정을 테스트할 수 있습니다. (파일 내 `WORKER_URL`을 본인의 URL로 수정 후 실행하세요)
