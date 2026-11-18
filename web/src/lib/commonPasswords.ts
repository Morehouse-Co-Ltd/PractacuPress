/**
 * 常见弱口令黑名单：与后端 `internal/auth/common_passwords.go` 的
 * `commonPasswordList` 保持**同一份内容**。
 *
 * 为什么前端也要一份：后端把「常见弱口令」拒绝为 `details.rule: too_common`，
 * 但 `message` 只是通用的「请求参数不符合要求」；前端先按同一份名单拦下，
 * 用户才能当场看到「请换一个更独特的口令」。改动任一侧时，另一侧必须同步
 * （`passwordPolicy.test.ts` 会守住名单的规模与经典条目）。
 *
 * 匹配规则与后端一致：整串、忽略大小写、精确匹配；不做前缀/后缀/leet 归一化，
 * 常见变体在名单里逐条列出。
 */
const COMMON_PASSWORD_LIST = `
password password1 password12 password123 password1234 password12345 password123456 password1234567 password12345678
password! password1! password12! password123! password1234! password12345!
password@1 password@12 password@123 password#1 password#123 password!1
passw0rd passw0rd1 passw0rd12 passw0rd123 passw0rd1234 passw0rd! passw0rd1! passw0rd123!
p@ssword p@ssword1 p@ssword12 p@ssword123 p@ssword1234
p@ssw0rd p@ssw0rd1 p@ssw0rd12 p@ssw0rd123 p@ssw0rd1234
pa55word pa55word1 pa55w0rd pa55w0rd1 pa55w0rd123
p4ssword p4ssword1 p4ssw0rd p4ssw0rd1 p4ssw0rd123
passwd passwd1 passwd123 passwd1234 passwd! passwordpassword1
letmein letmein1 letmein12 letmein123 letmein1234 letmein12345 letmein! letmein123!
l3tm31n l3tm31n1 l3tm31n12 l3tm31n123 l3tm31n1234 l3tm31n!
iloveyou iloveyou1 iloveyou12 iloveyou123 iloveyou1234 iloveyou! iloveyou123!
iloveu iloveu1 iloveu12 iloveu123 loveyou loveyou1 loveyou123
welcome welcome1 welcome12 welcome123 welcome1234 welcome12345 welcome! welcome2024 welcome2025 welcome2026
admin admin1 admin12 admin123 admin1234 admin12345 admin123456 admin123456789 admin! admin@123 admin@1234 admin123!
adminadmin adminadmin1 administrator administrator1 administrator123 adm1n adm1n1 adm1n123 adm1n1234
root root1 root12 root123 root1234 root12345 roottoor toor superuser superuser1 sysadmin sysadmin1 sysadmin123
default default1 default123 guest guest1 guest123
test test1 test12 test123 test1234 test12345 testing testing1 testing123 tester tester1 tester123
demo demo1 demo123 demo1234 changeme changeme1 changeme123
secret secret1 secret12 secret123 secret1234 secret12345 secret! secret123! s3cr3t s3cr3t1 s3cr3t12 s3cr3t123 s3cr3t1234 s3cur1ty
qwerty qwerty1 qwerty12 qwerty123 qwerty1234 qwerty12345 qwerty123456 qwerty! qwerty1! qwerty123! qwerty1234!
qwertyui qwertyuiop qwertyuiop1 qwertyuiop12 qwertyuiop123 qwertyuiop1234 qwertyuiop! qwertyuiop12! qwertyuiop123!
qwertz qwertz1 qwertz123 qwertz1234 azerty azerty1 azerty123 azerty1234 azertyuiop azertyuiop1
qazwsx qazwsx1 qazwsx123 qazwsx1234 qazwsxedc qazwsxedc1 qazwsxedc123 qazwsxedcrfv
qweasd qweasd1 qweasd123 qweasdzxc qweasdzxc1 qweasdzxc123 qweasdzxc1234 qwe123 qwe123qwe qwe123qwe123
1qaz2wsx 1qaz2wsx3edc 1qaz2wsx3edc4rfv 1qaz2wsx3edc4rfv5tgb
1q2w3e 1q2w3e4r 1q2w3e4r5t 1q2w3e4r5t6y 1q2w3e4r5t6y7u 1q2w3e4r5t6y7u8i
1q2w3e4r! 1q2w3e4r5t! 1q2w3e4r5t6y! 1q2w3e4r5t6y7u!
q1w2e3r4 q1w2e3r4t5 q1w2e3r4t5y6 q1w2e3r4t5y6u7 q1w2e3r4! q1w2e3r4t5! q1w2e3r4t5y6!
zaq12wsx zaq12wsxcde3 zaqwsxcde
zxcvbn zxcvbnm zxcvbnm1 zxcvbnm12 zxcvbnm123 zxcvbnm1234 zxcvbnm! zxcvbnm123!
asdf asdf1 asdf12 asdf123 asdf1234 asdf12345 asdf123456
asdfg asdfgh asdfghj asdfghjk asdfghjkl asdfghjkl1 asdfghjkl12 asdfghjkl123 asdfghjkl!
asdfasdf asdfasdf1 asdfasdf123
poiuytrewq poiuytrewq1 mnbvcxz mnbvcxz1 mnbvcxz123
123qwe 123qweasd 123qweasdzxc 123qweasdzxc123 1234qwer 1234qwerasdf qwer1234 qwer1234qwer qwerasdf qwerasdf123
0987654321 1234554321 1029384756 741852963 963852741 147852369 147258369 1472583690 2580 246810 13579
correcthorsebatterystaple
123456 1234567 12345678 123456789 1234567890 12345678901 123456789012 1234567890123 12345678901234 123456789012345
123456! 12345678! 123456789! 1234567890! 123456789012!
654321 6543210 987654321 9876543210 0123456789 01234567890 012345678901
000000 0000000 00000000 000000000 0000000000 00000000000 000000000000
111111 1111111 11111111 111111111 1111111111 11111111111 111111111111 111111111111!
222222 22222222 222222222 222222222222 333333 33333333 333333333 333333333333
444444 44444444 444444444 444444444444 555555 55555555 555555555 555555555555
666666 66666666 666666666 666666666666 777777 77777777 777777777 777777777777
888888 88888888 888888888 888888888888 999999 99999999 999999999 999999999999
121212 12121212 121212121 121212121212 123123 123123123 123123123123
112233 11223344 1122334455 112233445566 321321 321321321 321321321321
michael michael1 michael123 jennifer jennifer1 jennifer123 jessica jessica1 jessica123
ashley ashley1 ashley123 nicole nicole1 amanda amanda1 sarah sarah1 hannah hannah1
jordan jordan1 jordan23 jordan123 daniel daniel1 daniel123 andrew andrew1 andrew123
joshua joshua1 joshua123 matthew matthew1 thomas thomas1 robert robert1 william william1
charles charles1 anthony anthony1 patrick patrick1 george george1 edward edward1
richard richard1 steven steven1 charlie charlie1 charlie123 donald donald1 donald123
jesus jesus1 jesus123 jesuschrist heaven heaven1 blessed blessed1 faith faith1 peace peace1
angel angel1 angel123 angel1234 sunshine sunshine1 sunshine123
princess princess1 princess12 princess123 princess1234 princess! princess123!
flower flower1 flower123 butterfly butterfly1 beautiful beautiful1 beauty beauty1
baby baby1 baby12 baby123 baby1234 babygirl babygirl1 babygirl123
love love1 love123 love1234 lovely lovely1 lovely123
shadow shadow1 shadow123 master master1 master123 master1234 killer killer1 killer123
hunter hunter1 hunter2 hunter12 hunter123 hunter2! whatever whatever1 whatever123
nothing nothing1 nothing123
monkey monkey1 monkey12 monkey123 monkey1234 m0nk3y m0nk3y123
dragon dragon1 dragon123 dragon1234 dragon123456 drag0n drag0n123 dragonmaster
superman superman1 superman123 batman batman1 batman123 spiderman spiderman1 ironman ironman1
starwars starwars1 starwars123 pokemon pokemon1 pokemon123 naruto naruto1 matrix matrix1 matrix123
football football1 football123 football1234 baseball baseball1 baseball123 basketball basketball1
soccer soccer1 soccer123 hockey hockey1 hockey123 golfer golfer1 tennis tennis1 cricket
arsenal arsenal1 chelsea chelsea1 liverpool liverpool1 manchester manchester1 barcelona barcelona1
realmadrid juventus lakers lakers1 yankees yankees1 cowboys cowboys1 steelers packers
mustang mustang1 mustang123 corvette corvette1 ferrari ferrari1 porsche porsche1 mercedes mercedes1
harley harley1 harley123 chevrolet chevrolet1 toyota toyota1 honda honda1 nissan nissan1
samsung samsung1 samsung123 google google1 google123 facebook facebook1 facebook123 twitter twitter1
linkedin microsoft apple apple1 apple123 orange orange1 banana banana1
computer computer1 computer123 internet internet1 internet123 business business1
school school1 student student1 teacher teacher1
`;

/** 小写口令 → 是否命中；后端用 `strings.ToLower` 做同样的归一化。 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  COMMON_PASSWORD_LIST.split(/\s+/).filter(Boolean),
);

export default COMMON_PASSWORDS;