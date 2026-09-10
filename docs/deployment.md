# GitHub Actions로 서버에 배포

공개 프로젝트는 실제 서버 IP와 접속 정보를 포함하지 않습니다. 배포할 저장소의 Actions 설정을 통해 주입합니다. 이 문서의 workflow는 **Linux 서버 + systemd + SSH** 배포 예시입니다. 기존 배포 플랫폼이 있으면 소스를 전달하고 서비스를 재시작하는 부분을 해당 방식으로 대체하세요.

도구 이름을 별도로 설정하지 않으면 기본 이름 `Service Timeline`과 부제 `서비스 운영 기록`으로 실행됩니다. 로컬의 `branding.json`은 Git 제외 대상이므로 소스와 함께 배포되지 않습니다.

브랜딩의 `defaultTheme`으로 첫 방문 시 라이트(`"light"`, 기본값) 또는 다크(`"dark"`) 모드를 지정할 수 있습니다. 사용자가 선택한 모드는 각 브라우저에만 저장하므로 배포하거나 서버를 재시작해도 유지됩니다.

`timezone`에는 모든 사용자에게 공통으로 적용할 시간대를 지정합니다. 예: `"Asia/Seoul"`. 필드가 없으면 `"UTC"`이며 서버나 브라우저의 OS 시간대는 사용하지 않습니다. 웹에서 저장하면 즉시 날짜 구분과 입력·표시에 반영되며 기존 이벤트의 UTC 저장값은 유지됩니다.

`/etc/service-timeline.env`에 `BRANDING_FILE=/var/lib/service-timeline/branding.json`을 추가하면 로그인 후 웹 상단 **설정**에서 이름·부제·기본 테마·시간대를 편집하고 저장할 수 있습니다. 앱 계정에 파일과 상위 폴더의 읽기·쓰기 권한이 필요합니다. 예제 systemd 서비스의 `ReadWritePaths`에는 이 폴더가 포함되어 있습니다. 릴리스 밖에서 관리하므로 재배포해도 유지되며 파일이 없으면 기본값으로 시작한 뒤 첫 저장 때 생성합니다. 초기값을 준비하려면 [`branding.example.json`](../branding.example.json)을 해당 경로로 복사하세요.

다른 브랜딩 경로를 사용하려면 `BRANDING_FILE`, 파일·폴더 권한과 systemd 쓰기 허용 경로를 함께 설정해야 합니다. 웹 저장은 임시 파일 교체 방식이며 실패 시 기존 설정을 유지합니다. 이름을 바꿔도 암호화 데이터와 비밀번호는 그대로 사용합니다.

비밀번호를 분실한 경우 서버 운영자가 `DATA_DIR/SETUP_COMPLETE.txt`를 삭제하면 전체 데이터·설정·기존 비밀번호를 초기화하고 웹에서 새 비밀번호를 받을 수 있습니다. 위 배포 예시의 경로는 `/var/lib/service-timeline/SETUP_COMPLETE.txt`입니다. 완료 파일은 최초 설정 성공 시 생성합니다. 내부 파일 `.setup-marker-enabled`는 그대로 두며 백업·복원에는 두 파일을 함께 포함합니다. [초기화 절차와 삭제 범위](../README.md#저장백업복구)를 먼저 확인하세요.

## 최초 1회 준비

Danger Zone의 ZIP 업로드는 최대 8 GiB, 전체 요청 최대 2시간, 업로드 중 무응답 최대 2분을 지원합니다. 리버스 프록시를 사용하는 경우 해당 업로드 경로의 본문 크기·요청 시간 제한도 맞춰야 합니다. `DATA_DIR/.transfers`에는 복호화 ZIP과 복원 준비 데이터가 임시 저장되므로 앱 계정의 쓰기 권한과 충분한 여유 공간이 필요합니다. 이 디렉터리는 별도 운영 백업에서 제외합니다. [상세 운영 기준](data-transfer.md)을 참고하세요.

앱 서버에 Node.js 22.13 이상을 준비합니다. 런타임·인증서·서비스 계정 준비는 앱 배포 workflow에서 자동으로 설치하지 않습니다.

예시 경로:

```text
/srv/service-timeline/releases/<release>/   배포별 소스
/srv/service-timeline/current              현재 소스를 가리키는 심볼릭 링크
/var/lib/service-timeline/                 암호화된 데이터
/var/lib/service-timeline/branding.json    웹에서 편집하는 브랜딩 설정
/etc/service-timeline.env                  포트·주소·데이터 경로
```

`deploy/service-timeline.service.example`을 참고해 서비스 계정, 실행 경로, 데이터 경로를 서버에 설정합니다. 배포 계정에는 소스 배포 경로의 쓰기 권한과 해당 서비스만 재시작할 수 있는 권한을 부여합니다. 앱 실행 계정에는 데이터 디렉터리의 읽기·쓰기 권한이 필요합니다.

서비스 환경 예시:

```dotenv
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/service-timeline
BRANDING_FILE=/var/lib/service-timeline/branding.json
PUBLIC_ORIGIN=https://timeline.example.com
COOKIE_SECURE=true
```

reverse proxy는 원래 Host와 요청 본문·Origin 헤더를 전달하도록 설정합니다. HTTPS 접속 주소와 `PUBLIC_ORIGIN`을 맞춥니다. `/healthz`는 로그인 전에도 200을 반환하므로 프로세스 상태 확인에 사용할 수 있습니다. 데이터의 잠금 해제 여부를 의미하지는 않습니다.

## 저장소의 Actions 설정

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Variable | `DEPLOY_ENABLED` | 준비 후 `true` |
| Variable 또는 Secret | `DEPLOY_HOST` | 서버 IP 또는 호스트명 |
| Variable | `DEPLOY_PORT` | SSH 포트, 미설정 시 `22` |
| Variable | `DEPLOY_USER` | SSH 접속 계정 |
| Variable | `DEPLOY_PATH` | 소스 배포 경로, 예: `/srv/service-timeline` |
| Variable | `DEPLOY_SERVICE` | systemd 서비스 이름, 예: `service-timeline` |
| Secret | `DEPLOY_SSH_KEY` | 배포 전용 SSH 개인 키 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 신뢰할 수 있는 경로로 확인한 서버의 SSH host key 항목 |

원본 저장소에는 위 이름만 있습니다. 앱 암호화 비밀번호를 이 설정에 넣지 않습니다.

배포 대상 서버에 접근 가능한 **Linux self-hosted runner**가 필요합니다. 예시 runner에는 Bash, Git, tar, base64, OpenSSH가 미리 준비되어 있어야 합니다. workflow는 외부 Action이나 패키지를 다운로드하지 않습니다. 소스 조회는 저장소가 호스팅된 GitHub 주소와 자동 제공되는 `GITHUB_TOKEN`을 사용합니다.

`DEPLOY_KNOWN_HOSTS`는 서버 관리자 등 신뢰할 수 있는 경로로 확인한 값을 등록합니다. 배포 스크립트는 `StrictHostKeyChecking=yes`로 검증하며 실행 시 확인 없이 host key를 수집하지 않습니다.

## 실행

배포할 저장소의 Actions에서 **Deploy to server**를 수동 실행합니다. 기본 workflow에는 push 자동 배포를 활성화하지 않았습니다. 운영 환경에 따라 trigger와 runner label을 수정할 수 있습니다.

1. 필수 설정을 확인합니다. `DEPLOY_ENABLED`가 없으면 job을 건너뜁니다.
2. 지정된 커밋의 소스를 가져옵니다.
3. 서버의 새 release 디렉터리로 소스만 전송합니다.
4. 현재 release 링크를 교체하고 systemd 서비스를 재시작합니다.
5. 운영자가 웹 화면에서 비밀번호를 입력합니다.

빌드, npm/pip 설치, 컨테이너 이미지 다운로드는 수행하지 않습니다. 데이터는 소스 경로와 분리되어 재배포 후에도 유지됩니다. 배포 후 재로그인 전까지 데이터는 잠겨 있습니다.

배포 스크립트는 이전 release를 삭제하지 않습니다. 필요 시 운영자가 데이터 호환성을 확인한 뒤 이전 release로 링크를 되돌리고 서비스를 재시작할 수 있습니다.

사용할 runner의 접속 방식, SSH 포트, 서비스 경로, sudo 정책에 맞게 확인한 뒤 배포 workflow를 활성화하세요.
