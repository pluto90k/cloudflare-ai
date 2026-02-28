# Cloudflare AI (Whisper) Subtitle Extractor API

HLS 오디오 세그먼트를 Cloudflare Workers AI(`whisper-large-v3-turbo`)를 통해 텍스트 자막(VTT)으로 생성하는 고성능 비동기 API 처리기입니다.

## 아키텍처 특징 및 한계점 필독 (Archived Analysis)
현재 버전은 긴 오디오 파일 처리 시 직면하는 5006 페이로드 직렬화 에러를 피하기 위해 **[30초 청크 단위 병합 전송 구조]**가 적용되어 있습니다. 
그러나 Whisper 모델이 빈 침묵/노이즈 구간에서 일으키는 치명적인 환각 증세(Hallucination 버그) 한계로 인해, 프로덕션 레벨이 아닌 연구/분석용 코드로 아카이브 되었습니다.

상세한 아키텍처 구조, 해결 과정, 그리고 외부 상용 STT 서비스(OpenAI, Deepgram 등) 도입 필요성에 대한 분석 보고서는 아래 문서를 참조하시기 바랍니다.

- [분석 보고서 (analysis_results.md)](./analysis_results.md)
- [기술 검증 요약 및 API 가이드 (walkthrough.md)](./walkthrough.md)
