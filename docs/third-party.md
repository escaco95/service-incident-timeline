# 포함된 외부 라이브러리

패키지 설치나 CDN 연결 없이 실행하도록 브라우저용 배포 파일을 저장소에 포함한다.

| 라이브러리 | 용도 | 버전 | 라이선스 |
| --- | --- | --- | --- |
| [DOMPurify](https://github.com/cure53/DOMPurify/releases/tag/3.4.15) | 이벤트 HTML 본문 표시용 사본 정제 | 3.4.15 | Apache-2.0 또는 MPL-2.0 |

- 배포 파일: `public/vendor/dompurify/purify.es.js`
- 원본: <https://raw.githubusercontent.com/cure53/DOMPurify/3.4.15/dist/purify.es.mjs>
- 배포 파일 SHA-256: `e7d8182ea0aae9daa46c3294a486067b3f4461bd18f8ca76e499c623e9bda6e3`
- 라이선스 전문: [LICENSE](../public/vendor/dompurify/LICENSE)

DOMPurify의 보안 릴리스를 확인하여 배포 파일·버전·해시·라이선스를 함께 갱신한다. 갱신 후 `node scripts/browser-check.mjs`로 표·기본 서식 보존, HTML 공격 입력, 외부 리소스 차단, 링크 확인을 검증한다. 원본 배포 코드의 로컬 수정은 하지 않는다.
