# My Skills

내가 쓰던 AI 스킬을 목적별 폴더와 `package.json`으로 모아 둔 저장소.

각 폴더의 `package.json`에 원본 주소, 스킬 경로, 커밋을 기록한다. 명령을 실행할 때 원본 스킬 폴더를 내려받는다. 다운로드 파일은 Git에서 제외한다.

## 폴더 구성

```text
my-skills/
├── dev/package.json         # 개발 공통 (4개)
├── frontend/package.json    # 프론트엔드 개발 (6개)
├── backend/package.json     # 백엔드 개발 (2개)
├── design/package.json      # 디자인 방향 (5개)
├── imagegen/package.json    # 이미지와 브랜드 (4개)
├── planning/package.json    # 기획 (1개, 원본 주소 확인 필요)
├── scripts/download.js     # 공용 다운로드 명령
└── package.json             # 전체 묶음 관리
```

## 사용법

Node.js 22 이상과 Git이 필요하다. 별도 npm 패키지 설치 없이 실행할 수 있다.

원하는 폴더로 이동해 실행한다.

```sh
cd frontend
npm run download
```

`frontend/downloads/스킬이름/` 아래에 `SKILL.md`와 스크립트·데이터 등 원본 폴더 전체가 저장된다.

저장소 루트에서 묶음을 선택할 수도 있다. 여러 묶음을 선택하면 한 폴더에 모아 받는다.

```sh
npm run download -- frontend
npm run download -- dev frontend --dest "D:/my-project/skills"
```

`--dest`는 명령을 실행한 폴더 기준의 경로다. 생략하면 실행 폴더의 `downloads/`에 저장한다.

```sh
npm run list                                  # 전체 목록
npm run download -- frontend --dry-run        # 다운로드할 원본 미리 보기
npm run download -- frontend --force          # 기존 같은 이름의 스킬 폴더 교체
npm run check                                # 모든 package.json의 설정 검사
npm test                                     # 다운로드 동작 검증
```

기존 폴더는 기본적으로 유지한다. `--force`를 쓰면 그 스킬 폴더 전체를 원본으로 교체하므로 로컬 수정도 교체된다. 내려받기에 실패하면 오류로 종료하며, 교체 중 실패하면 기존 폴더 복구를 시도한다.

`npm install`은 스킬을 다운로드하지 않는다. 원본 다운로드는 `npm run download`로 실행한다. Codex나 Claude 등의 설치 경로는 정해 두지 않았으므로 필요한 위치는 `--dest`로 지정한다.

## 목적별 목록

- [개발 공통](dev/README.md)
- [프론트엔드 개발](frontend/README.md)
- [백엔드 개발](backend/README.md)
- [디자인 방향](design/README.md)
- [이미지와 브랜드](imagegen/README.md)
- [기획과 아이템 발굴](planning/README.md)

총 22개 중 원본 링크를 확인한 21개를 다운로드할 수 있다. `micro-saas-finder`는 원본 주소가 없어 보류로 표시하며 다운로드하지 않는다.

## 스킬 추가하기

해당 폴더의 `package.json`에 있는 `skillBundle.skills`에 추가한다.

```json
"skill-name": {
  "description": "스킬 용도",
  "repository": "https://github.com/owner/repository",
  "ref": "확인한 40자리 Git 커밋",
  "path": "skills/skill-folder"
}
```

`path`는 저장소 기준 스킬 폴더이며 그 안에 이름이 일치하는 `SKILL.md`가 있어야 한다. 기존 폴더의 스킬 목록도 함께 갱신한다. 출처를 모르면 `repository`, `ref`, `path` 대신 `"status": "source-needed"`를 기록한다.

커밋을 고정하여 같은 원본을 다시 받을 수 있다. 원본을 갱신하려면 `ref`를 새 커밋으로 바꾼다. 원본에 심볼릭 링크나 서브모듈이 들어 있으면 불완전한 복사를 방지하기 위해 오류로 종료한다. 스킬 본문과 사용 조건은 각 원본 저장소를 따른다.
