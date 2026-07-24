창신체크미 v11 · Firebase 완전 연결본

이미 적용된 Firebase 프로젝트
- projectId: changsin-checkme
- 익명 로그인 사용
- Firestore checks 컬렉션 사용
- Storage checks/{uid}/{checkId}/ 경로 사용

깃허브 적용
1. 이 ZIP의 압축을 풉니다.
2. 폴더 자체가 아니라 안의 파일 전부를 기존 GitHub 저장소 최상단에 올립니다.
3. Add file → Upload files → Commit changes.
4. GitHub Pages 배포가 끝날 때까지 1~3분 기다립니다.
5. 아이폰에서 기존 홈 화면 앱을 삭제하고 Safari로 Pages 주소를 연 뒤 다시 홈 화면에 추가합니다.

Firebase에서 이미 끝낸 설정
1. Authentication → 익명 로그인 활성화
2. Firestore Database 생성
3. Storage 생성
4. firestore.rules 내용을 Firestore 규칙 탭에 게시
5. storage.rules 내용을 Storage 규칙 탭에 게시

첫 테스트
1. 앱 → 설정 → Firebase 연결 확인
2. 현재 위치 저장
3. 테스트 사진 7장 촬영
4. 100%가 된 뒤 공유하기
5. 카카오톡 나에게 공유하고 링크를 열어 사진 7장과 시간이 보이는지 확인

중요
- firebase-config.js의 값은 웹용 공개 설정값입니다. 서비스 계정 JSON이나 private_key는 절대 올리지 마세요.
- 10m GPS 경고는 앱이 화면에 열려 있을 때만 비교적 빠르게 동작합니다. 실내 GPS 오차 때문에 정확도 15m 이하 위치가 3회 연속 반경 밖일 때만 울립니다.
- 아이폰 앱이 닫혀 있을 때는 단축어의 '떠날 때' 자동화를 함께 사용하세요.
- Firebase 공유 사진은 Storage에 계속 남습니다. 필요 없는 기록을 자동 삭제하는 기능은 아직 포함하지 않았습니다.
