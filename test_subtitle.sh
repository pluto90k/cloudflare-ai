#!/bin/bash

# Cloudflare AI Subtitle Extraction Test Script (TS List Version)

# 1. Configuration
WORKER_URL="https://your-worker.your-subdomain.workers.dev" # 배포된 워커 URL로 수정하세요
LANGUAGE="ko"

# 테스트용 TS 파일 리스트 (예시)
# 실제 테스트 시에는 접근 가능한 URL로 변경하세요.
TS_URLS='[
  "https://example.com/audio_segment_0.ts",
  "https://example.com/audio_segment_1.ts",
  "https://example.com/audio_segment_2.ts"
]'

echo "--- 1. Starting Subtitle Process (TS List) ---"
# JSON body로 요청
START_RES=$(curl -s -X POST "$WORKER_URL/process-ts" \
  -H "Content-Type: application/json" \
  -d "{
    \"tsUrls\": $TS_URLS,
    \"language\": \"$LANGUAGE\"
  }")

JOB_ID=$(echo $START_RES | jq -r '.jobId')

if [ "$JOB_ID" == "null" ] || [ -z "$JOB_ID" ]; then
  echo "Failed to start job: $START_RES"
  exit 1
fi

echo "Job Started: $JOB_ID"
echo "Response: $START_RES"
echo ""

# 2. Status Polling
echo "--- 2. Checking Status (Polling) ---"
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  STATUS_RES=$(curl -s "$WORKER_URL/status?jobId=$JOB_ID")
  STATUS=$(echo $STATUS_RES | jq -r '.status')
  
  echo "Current Status: $STATUS"
  
  if [ "$STATUS" == "completed" ]; then
    echo "Processing Finished!"
    break
  elif [ "$STATUS" == "failed" ]; then
    ERROR=$(echo $STATUS_RES | jq -r '.error')
    echo "Job Failed: $ERROR"
    exit 1
  fi
  
  RETRY_COUNT=$((RETRY_COUNT+1))
  sleep 5
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "Timeout waiting for job completion."
  exit 1
fi

echo ""

# 3. Download VTT
echo "--- 3. Downloading Final VTT ---"
curl -s -o "result_$JOB_ID.vtt" "$WORKER_URL/get-final-vtt?jobId=$JOB_ID"

if [ -f "result_$JOB_ID.vtt" ]; then
  echo "Success! VTT saved as result_$JOB_ID.vtt"
  echo "--- VTT Content Preview ---"
  head -n 10 "result_$JOB_ID.vtt"
else
  echo "Failed to download VTT."
fi
