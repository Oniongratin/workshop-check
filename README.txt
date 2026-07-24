창신체크미 v3

이번 버전 기능
- 항목을 원하는 순서대로 촬영
- 날짜별 사진 기록
- 잠시 외출 모드
- 웹앱이 열려 있을 때 작업실 반경 이탈 경고
- Firebase 연결 후 사진 확인용 공유 링크 생성
- 아이폰 단축어 위치 자동화와 연동 가능

GitHub에 올릴 파일
- index.html
- app.js
- firebase-config.js
- manifest.webmanifest
- sw.js
- icon-192.png
- icon-512.png

Firebase 콘솔에서 별도로 사용하는 파일
- firestore.rules
- storage.rules
이 두 파일은 GitHub에 올려도 앱 실행에는 영향이 없지만, Firebase 콘솔의 Rules 화면에 내용을 복사해 적용해야 합니다.

중요
1. firebase-config.js 안의 여기에_... 값을 Firebase 웹 앱 설정값으로 교체해야 사진 링크 공유가 작동합니다.
2. Firebase Authentication에서 Anonymous 로그인을 활성화해야 합니다.
3. Firestore Database와 Storage를 생성하고 제공한 규칙을 적용해야 합니다.
4. Firebase Storage는 계정/프로젝트 상태에 따라 결제 계정 연결을 요구할 수 있습니다.
5. 아이폰이 웹앱을 완전히 닫은 상태의 위치 이탈 감지는 단축어 자동화가 담당해야 가장 안정적입니다.
