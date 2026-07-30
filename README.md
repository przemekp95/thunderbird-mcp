# Thunderbird MCP Safe

Lokalny, utwardzony fork `TKasperczyk/thunderbird-mcp`, przeznaczony do
kontrolowanej pracy z pocztą i kontaktami z jawnie wybranych kont oraz książek
adresowych Thunderbirda.

Repo powstało z commita upstream:
`41c73ae5ffde78394313e84e89a957c9c4d6b91f` (`0.7.4`).
Fork ma własny identyfikator dodatku, katalog połączenia i preferencje. Push do
zdalnego upstreamu jest lokalnie wyłączony.

## Co jest dostępne

MCP domyślnie publikuje dokładnie 27 narzędzi. Po osobnym lokalnym włączeniu
`sendMailDirect` liczba rośnie do 28:

- odczyt: `listAccounts`, `listFolders`, `searchMessages`,
  `getRecentMessages`, `getMessage`, `getMessages`, `displayMessage`,
  `getAccountAccess`;
- tworzenie wiadomości: `sendMail`, `saveDraft`, `replyToMessage`,
  `forwardMessage`; po osobnym lokalnym włączeniu także `sendMailDirect`;
- organizacja: `updateMessage`, `deleteMessages`, `createFolder`,
  `renameFolder`, `deleteFolder`, `moveFolder`;
- kontakty: `searchContacts`, `getContact`, `createContact`, `updateContact`.
- filtry: `listFilters`, `createFilter`, `updateFilter`, `disableFilter`,
  `deleteFilter`.

Treść i metadane wiadomości oraz kontakty są jawnie oznaczane jako dane
niezaufane. Tekst, Markdown i HTML mają limity rozmiaru; surowy RFC822 jest
ograniczony do 2 MiB. Metadane załączników są widoczne zawsze, a jawnie żądany
zapis pobiera najwyżej 10 plików po 5 MiB do prywatnego katalogu tymczasowego
danego profilu i usuwa je przy zamknięciu dodatku.

`sendMail`, `replyToMessage` i `forwardMessage` zawsze otwierają okno tworzenia
wiadomości w Thunderbirdzie. MCP nie ma parametru pozwalającego wysłać ją
bez podglądu. Załączniki wychodzące mogą być przekazane tylko jako dane inline
base64; ścieżki do plików komputera są odrzucane w schemacie i dispatcherze.

`sendMailDirect` jest osobnym narzędziem i pozostaje ukryte, dopóki użytkownik
nie włączy go w opcjach dodatku. Włączenie wymaga frazy `ENABLE DIRECT SEND`,
co najmniej jednego jawnie wybranego konta nadawczego, reguły odbiorcy,
limitu odbiorców na wiadomość oraz dziennego limitu zaakceptowanych prób.
Reguła odbiorcy może być dokładnym adresem albo domeną w formie
`*@example.com`; globalny wildcard nie istnieje. Każda zaakceptowana próba i
jej wynik trafiają do prywatnego lokalnego dziennika bez tematu i treści
wiadomości. Automatyczna wysyłka dopuszcza najwyżej trzy załączniki inline i
blokuje całą wiadomość, jeśli przygotowanie któregokolwiek z nich się nie uda.
Dziennik ma limit 5 MiB; po jego osiągnięciu automatyczna wysyłka zatrzymuje się
do czasu świadomej archiwizacji lub usunięcia dziennika przez użytkownika.

Filtry mają odrębny, ograniczony model bezpieczeństwa. `listFilters` pokazuje
reguły na dozwolonych kontach, ale pozostałe cztery narzędzia mogą zmieniać
wyłącznie reguły utworzone wcześniej przez ten fork. Nowa reguła zawsze
powstaje wyłączona. MCP nie ma operacji włączania, uruchamiania ani zmiany
kolejności reguł; włączenie wykonuje się ręcznie w oknie „Filtry wiadomości”
Thunderbirda. Dozwolone akcje to przeniesienie lub skopiowanie do bezpiecznego
folderu tego samego konta, oznaczenie jako przeczytane/nieprzeczytane,
oznaczenie gwiazdką oraz dodanie istniejącej etykiety. Niedostępne są m.in.
usuwanie, wysyłanie/przekazywanie i zatrzymanie wykonywania kolejnych reguł.

Każda rzeczywista zmiana filtra wymaga aktualnej rewizji zwróconej przez
`listFilters`. Przed zapisem powstaje prywatna, trwała kopia pliku reguł oraz
wpis audytowy bez wartości warunków. Zachowywanych jest najwyżej 20 kopii;
pojedynczy plik reguł i dziennik mają limit 5 MiB. Definicje niekompletne,
nieznane, tymczasowe albo ręcznie rozbudowane poza bezpieczny podzbiór są
tylko do odczytu.

`createFolder` nie zgłasza sukcesu bez potwierdzenia Thunderbirda. Dla IMAP
najpierw sprawdza, czy folder nie istnieje już na serwerze jako
niesubskrybowany. Taki folder jest subskrybowany i ujawniany zamiast ponownej
próby utworzenia. Następnie MCP czeka na zakończenie operacji serwerowej i
zwraca `success: true` wyłącznie z niepustym, ponownie rozwiązywalnym URI oraz
`verified: true`. Operacja otrzymuje kontekst aktywnego okna poczty, aby
dostawca IMAP mógł zakończyć uwierzytelnienie zamiast pozostawić żądanie bez
callbacku. Natywny listener URL używa nazw metod wymaganych przez
`nsIUrlListener`, więc odrzucenie przez serwer kończy wywołanie od razu z
podpowiedzią wyboru korzenia konta lub zwykłego folderu użytkownika. Brak
odpowiedzi w ciągu 25 sekund jest zwracany jako `status: "unconfirmed"` —
nigdy jako sukces z
`path: null`. Folder najwyższego poziomu tworzy się przez `accountId`; dla
folderu zagnieżdżonego podaje się `parentFolderPath`. Filtr przenoszący lub
kopiujący do folderu IMAP jest dopuszczany dopiero, gdy Thunderbird potwierdza
folder jako istniejący online.

## Czego ta wersja nie potrafi

- wysyłać automatycznie bez wcześniejszego lokalnego włączenia oraz zgodności
  konta, wszystkich odbiorców i limitów z polityką;
- zezwalać jednym wildcardem na wszystkich odbiorców;
- usuwać trwale wiadomości, folderów ani kontaktów;
- opróżniać Kosza lub folderu Spam;
- automatycznie włączać, uruchamiać lub zmieniać kolejności filtrów;
- zmieniać istniejących reguł użytkownika ani reguł spoza bezpiecznego
  podzbioru;
- czytać ani zmieniać kalendarzy i zadań;
- zwracać osadzonych obrazów jako osobnych bloków MCP;
- czytać dowolnych plików hosta przez mostek;
- nasłuchiwać poza `127.0.0.1`;
- używać stałego tokenu;
- aktualizować dodatku automatycznie.

Brak wybranego konta oznacza brak dostępu do wszystkich kont. Kontakty mają
osobną białą listę: brak wybranej książki adresowej blokuje wszystkie kontakty.
Nie istnieje tryb „pusta lista = wszystko”.

## Budowanie i testy

Wymagany jest Node.js 18 lub nowszy.

```bash
npm install --no-save --package-lock=false
node scripts/build-xpi.cjs
npm test
npm run lint
```

Artefakt powstaje jako `dist/thunderbird-mcp-safe.xpi`. Przed instalacją należy
zapisać i porównać jego SHA-256 z wynikiem zweryfikowanego lokalnego buildu.
Test regresyjny porównuje krytyczne pliki w XPI ze źródłami, więc nieaktualny
artefakt powoduje błąd całego zestawu.

Build jest reprodukowalny dla niezmienionych źródeł: wpisy ZIP mają stałą
kolejność, a `buildinfo.json` używa `SOURCE_DATE_EPOCH` lub czasu commita Git
zamiast zegara uruchomienia. Dwa kolejne buildy tego samego stanu muszą mieć
identyczny SHA-256; sprawdza to również automatyczny test.

## Bezpieczny pilot

1. Zbuduj i zweryfikuj XPI.
2. Zainstaluj XPI ręcznie przez menedżer dodatków Thunderbirda.
3. Otwórz ustawienia `Thunderbird MCP Safe`.
4. Wybierz konto oraz książkę adresową przeznaczone do pilota. Te dwie listy
   są niezależne i domyślnie puste.
5. Opcjonalne `sendMailDirect` włącz dopiero po wpisaniu kont nadawczych,
   reguł odbiorców i limitów. Bez tego narzędzie nie pojawia się w `tools/list`.
6. W sekcji `Local server` skopiuj dokładną wartość `Connection file`. Każdy
   profil Thunderbirda dostaje osobny losowy `Safe profile ID` i osobny plik.
   Identyfikator jest związany z kanoniczną ścieżką profilu, więc skopiowanie
   lub przeniesienie profilu wymusza nowy identyfikator.
7. Skonfiguruj klienta MCP, aby uruchamiał mostek z tą ścieżką w zmiennej
   środowiskowej `THUNDERBIRD_MCP_CONNECTION_FILE`:

   ```text
   THUNDERBIRD_MCP_CONNECTION_FILE=<dokładna ścieżka z ustawień dodatku>
   node /home/przemekp95/workspace/thunderbird-mcp-safe/mcp-bridge.cjs
   ```

   Mostek celowo nie uruchomi narzędzi pocztowych bez tej zmiennej i nie
   wyszukuje innych profili. Przy Thunderbirdzie uruchomionym w Snap/Flatpak
   ścieżka widoczna wewnątrz aplikacji może wymagać przetłumaczenia na
   odpowiadającą jej ścieżkę widoczną dla hosta; należy przypiąć jeden konkretny
   plik, a nie używać wyszukiwania wieloznacznego.

   Jeżeli wymuszone zakończenie Thunderbirda pozostawi `connection.json`,
   mostek sprawdza zapisany PID przed użyciem portu i tokenu. Plik wskazujący
   na nieistniejący proces jest traktowany jak brak aktywnego połączenia.
   Mostek go nie usuwa, aby nie ścigać się ze startującym Thunderbirdem; czeka,
   aż dodatek przepisze dokładnie ten sam przypięty plik.

   Dla lokalnego Codex wpis ma postać:

   ```toml
   [mcp_servers.thunderbird_safe]
   command = "/usr/bin/node"
   args = ["/home/przemekp95/workspace/thunderbird-mcp-safe/mcp-bridge.cjs"]

   [mcp_servers.thunderbird_safe.env]
   THUNDERBIRD_MCP_CONNECTION_FILE = "<dokładna ścieżka jednego profilu>"
   ```

   Nie dodawaj tego wpisu, dopóki osobny profil testowy i właściwy plik
   połączenia nie zostały zweryfikowane.
8. Najpierw sprawdź tylko `getAccountAccess`, `listAccounts`, `listFolders`
   oraz wyszukiwanie syntetycznego kontaktu.
9. Potem przetestuj odczyt nieszkodliwej wiadomości, zapis małego syntetycznego
   załącznika, utworzenie szkicu oraz folderu przez `accountId`. Sukces folderu
   musi zawierać niepusty `path` i `verified: true`; ten sam folder musi być
   widoczny po ponownym `listFolders`.
10. Utwórz syntetyczną regułę, potwierdź, że pozostaje wyłączona po restarcie,
    sprawdź odrzucenie starej rewizji, a następnie usuń ją przez MCP.
11. Na końcu sprawdź, czy wysyłka/odpowiedź zawsze zatrzymuje się w oknie
   podglądu, a usuwanie przenosi tylko do Kosza.

Nie instaluj równocześnie forka i upstreamu bez wyraźnej potrzeby. Mają osobne
tożsamości i katalogi połączeń, ale użytkownik łatwo może pomylić ich mostki.

## Granice bezpieczeństwa

To jest redukcja ryzyka, nie pełna izolacja:

- wybrana treść poczty trafia do klienta/modelu używającego MCP; polityka
  prywatności tego modelu pozostaje osobnym zaufaniem;
- treść e-maila może zawierać prompt injection, dlatego klient nadal musi
  traktować pole z `contentTrust: "untrusted-email-data"` jako dane, nie
  polecenia; samo oznaczenie nie chroni innych narzędzi dostępnych modelowi;
- pole `contentTrust: "untrusted-email-data"` dotyczy również HTML i surowego
  MIME; klient nie powinien renderować HTML ani automatycznie otwierać linków;
- zapisany załącznik nadal może być złośliwym plikiem; samo zapisanie nie
  oznacza zgody na uruchomienie, otwarcie lub przesłanie;
- proces działający jako ten sam użytkownik systemowy może próbować odczytać
  plik połączenia, mimo trybu `0600`;
- kontrola PID blokuje typowy stary plik po awarii, ale nie jest ochroną przed
  złośliwym procesem tego samego użytkownika ani przed skrajnym przypadkiem
  ponownego użycia tego samego numeru PID;
- odczyt folderów IMAP może uruchomić zwykłą synchronizację Thunderbirda oraz
  zmienić lokalny cache lub indeks;
- fork nie ma trwałego dziennika wszystkich wywołań; trwały audyt obejmuje
  automatyczną wysyłkę oraz mutacje filtrów;
- zgodność z nowymi wydaniami Thunderbirda trzeba ponownie testować przed
  aktualizacją klienta.

Szczegółowy model zagrożeń i kryteria akceptacji są w
[`SECURITY.md`](SECURITY.md).

## Wycofanie

Usuń dodatek w menedżerze dodatków Thunderbirda i usuń konfigurację MCP
uruchamiającą `mcp-bridge.cjs` wraz z
`THUNDERBIRD_MCP_CONNECTION_FILE`. Przy zamykaniu dodatek usuwa plik połączenia
tylko z katalogu własnego profilu. Repo można potem skasować niezależnie od
profilu poczty.

## Licencja i pochodzenie

Kod bazowy pochodzi z
[`TKasperczyk/thunderbird-mcp`](https://github.com/TKasperczyk/thunderbird-mcp)
i pozostaje na licencji MIT. Ten fork nie jest oficjalnym wydaniem upstreamu.
