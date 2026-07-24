창신체크미 v12 · Firebase 실제 연결 및 7번째 사진 멈춤 수정본

핵심 수정
- 사진 원본/압축본을 localStorage에 넣지 않고 IndexedDB에 저장
- 7번째 사진에서 localStorage 용량 초과로 멈추던 문제 해결
- 촬영 처리 중 중복 탭 방지
- 마지막 사진 저장 후 완료 상태와 기록이 정상 반영
- 공유 시 IndexedDB 사진 7장을 Firebase Storage에 업로드
- Firestore에 공유 문서를 저장하고 실제 URL을 공유
- Firebase 연결 확인 버튼이 임시 문서를 쓰고 읽고 삭제해 실제 연결 검증
- 오류 메시지를 권한/네트워크/Storage/익명 로그인으로 구분
- 서비스워커 캐시 버전 v12로 교체하고 앱 파일은 네트워크 우선

GitHub 업로드
1. 이 폴더 안의 파일 전체를 저장소 루트에 덮어쓰기
2. Commit changes
3. Actions의 pages build and deployment가 초록 체크가 될 때까지 기다리기
4. 아이폰 홈 화면 앱 삭제
5. 설정 > Safari > 고급 > 웹사이트 데이터에서 oniongratin.github.io 삭제
6. Safari로 https://oniongratin.github.io/workshop-check/ 접속
7. 화면 상단에 WORKSHOP CHECK · v12가 보이는지 확인
8. 다시 홈 화면에 추가

Firebase
- firebase-config.js에는 changsin-checkme 프로젝트 설정이 이미 입력됨
- firestore.rules와 storage.rules는 Firebase 콘솔에 게시한 규칙과 같아야 함
- Authentication > 로그인 방법 > 익명 사용 설정 필요
