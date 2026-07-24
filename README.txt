창신체크미 v13

수정 사항
- Firebase 권한을 사진 업로드 전에 확인
- iPhone Web Share 제한 대응: 첫 탭은 링크 생성, 두 번째 탭은 공유창 열기
- 공유 링크 생성 후 앱에 보존하여 재업로드 방지
- 홈 화면에 '점검 다시 시작' 버튼 추가
- Firestore 규칙 파일 갱신

중요
Firebase Console > Firestore Database > 규칙에서 firestore.rules 내용을 그대로 붙여넣고 '게시'해야 합니다.
그 뒤 앱 설정 > 연결 확인을 눌러 'Firebase 연결됨'이 뜨는지 확인하세요.
