# Security model

## Cel

Umożliwić lokalnemu klientowi MCP kontrolowaną pracę z pocztą i kontaktami
z jawnie wskazanych kont i książek adresowych. Automatyczna wysyłka jest
osobną, domyślnie wyłączoną zdolnością z allowlistą kont, opcjonalnymi
ograniczeniami odbiorców, limitami i audytem; permanentne kasowanie i odczyt
dowolnych plików systemowych pozostają
niedostępne.

## Aktywa

- treść i metadane wiadomości;
- tożsamości kont pocztowych;
- kontakty i książki adresowe;
- szkice oraz organizacja folderów;
- token lokalnego serwera MCP;
- profil Thunderbirda;
- pliki użytkownika poza profilem pocztowym.
- prywatny dziennik zaakceptowanych prób automatycznej wysyłki.
- trwałe definicje filtrów, ich kopie bezpieczeństwa i dziennik mutacji.
- opcjonalne, przekazane na czas jednej wysyłki hasło SMTP.

## Granice zaufania

```text
klient/model MCP
        |
        | stdio JSON-RPC
        v
lokalny mostek Node.js
        |
        | HTTP POST + rotowany Bearer token, 127.0.0.1
        v
uprzywilejowany dodatek Thunderbirda
        |
        v
jawnie dozwolone konta pocztowe i książki adresowe
```

Treść każdej wiadomości znajduje się po niezaufanej stronie granicy. Nie jest
traktowana jako instrukcja ani konfiguracja.

## Wymuszenia

1. Manifest żąda wyłącznie `accountsRead`, `messagesRead`, `accountsFolders`,
   `messagesMove`, `addressBooks` i `compose`.
2. Stała biała lista narzędzi jest sprawdzana przy `tools/list`, przed
   walidacją wywołania oraz ponownie w dispatcherze.
3. Brak lub uszkodzenie preferencji kont blokuje wszystkie konta. Osobna,
   domyślnie pusta lista robi to samo dla książek adresowych.
4. `getMessage` pozwala na ograniczony tekst, Markdown, HTML, raw RFC822 oraz
   jawny zapis załączników. Wszystkie wyniki pozostają oznaczone jako
   niezaufane; raw ma limit 2 MiB, a zapis załączników 10 plików po 5 MiB.
5. Wyszukiwanie pełnej treści (`searchBody`) nie jest wystawione.
6. Wyniki są ograniczone rozmiarem, czyszczone ze znaków sterujących i
   opatrzone strukturalnym polem zaufania. Ciągi przypominające znaczniki
   graniczne są kodowane, ale klient nadal musi egzekwować politykę dla
   niezaufanych danych.
7. Schemat i dispatcher odrzucają ścieżki do wychodzących załączników. Dozwolone
   są wyłącznie obiekty inline base64. Pliki przychodzące trafiają do prywatnego
   katalogu profilu i są usuwane przy zamknięciu dodatku.
8. Serwer wiąże się wyłącznie z pętlą zwrotną.
9. 256-bitowy token jest generowany od nowa przy każdym starcie serwera.
10. Każdy profil ma losowy, trwały identyfikator i własny katalog
    `thunderbird-mcp-safe/<profile-id>` w trybie `0700`; plik połączenia ma
    tryb `0600`. Identyfikator jest powiązany z kanoniczną ścieżką `ProfD`;
    kopia lub przeniesienie profilu otrzymuje nowy identyfikator.
11. Mostek wymaga dokładnej ścieżki
    `THUNDERBIRD_MCP_CONNECTION_FILE`. W ścieżce wykonawczej nie skanuje
    profili ani nie przełącza się na inny plik. Przed użyciem połączenia
    sprawdza również, czy PID zapisany przez dodatek nadal istnieje; stary plik
    po awarii jest odrzucany bez wysyłania żądania na zapisany port.
12. Fork nie ma `update_url`, generatora aktualizacji ani workflow publikacji.
13. `sendMail`, odpowiedź i przekazanie zawsze otwierają okno podglądu.
    Osobne `sendMailDirect` jest ukryte i blokowane, dopóki lokalna konfiguracja
    nie zawiera jawnego włączenia, kont nadawczych oraz limitów. Narzędzie wymaga
    jawnej tożsamości nadawcy, waliduje wszystkich odbiorców `to`/`cc`/`bcc`,
    egzekwuje opcjonalną listę ograniczeń odbiorców, rezerwuje dzienny limit
    przed transportem i nie ogranicza liczby załączników inline. Zwykły
    `sendMail` nie dziedziczy tej zdolności. Opcjonalne `smtpPassword` jest
    przekazywane wyłącznie do natywnej funkcji wysyłania, bez zapisu w
    preferencjach i dzienniku dodatku; historia wywołań po stronie klienta MCP
    pozostaje osobną granicą zaufania.
    `listThunderbirdWindows` nie zwraca wartości pól haseł. Osobne
    `closeThunderbirdWindow` może zamknąć wyłącznie wskazany żywy podgląd
    `mail:messageWindow` z natywnego `messageWindow.xhtml`. Nie zamyka
    okien głównych, edytorów ani dialogów i sprawdza faktyczne zamknięcie.
    `respondToSmtpPrompt` przyjmuje hasło tylko dla żywego okna
    `commonDialog.xhtml` typu `promptPassword`, którego tytuł zawiera `SMTP`
    oraz nazwę skonfigurowanego serwera. Nie daje ogólnego klikania w oknach;
    użyte hasło może być widoczne w historii klienta MCP.
14. Każda zaakceptowana próba `sendMailDirect` jest przed transportem zapisywana
    w prywatnym pliku `direct-send-audit.jsonl`; wpis zawiera identyfikator,
    konto, odbiorców, rozmiary pól i liczbę załączników, ale nie temat ani treść.
    Błąd pierwszego wpisu albo osiągnięcie limitu pliku 5 MiB blokuje wysyłkę.
15. Kasowanie wiadomości i folderów wymaga `confirmTrash: true`, działa
    maksymalnie na 50 wiadomościach i zawsze kopiuje/przenosi do Kosza.
    Wywołanie na zawartości Kosza jest odrzucane.
16. Filtry można listować, tworzyć, aktualizować, wyłączać i usuwać w
    ograniczonym modelu. MCP tworzy je zawsze wyłączone i może zmieniać tylko
    reguły oznaczone losowym identyfikatorem tego forka. Nie istnieje narzędzie
    do włączania, uruchamiania ani zmiany kolejności reguł.
17. Zmiana nazwy, przenoszenie i usuwanie chronionych folderów systemowych
    (m.in. Inbox, Sent, Drafts, Trash i Junk) są odrzucane.
18. Mutacja filtra wymaga niejawnego identyfikatora i aktualnej rewizji.
    Niekompletne, nierozpoznane, tymczasowe, grupowane lub ręcznie rozszerzone
    definicje są tylko do odczytu. Zmiana definicji i usunięcie wymagają reguły
    wyłączonej.
19. Akcje filtrów są ograniczone do przeniesienia/kopiowania w obrębie tego
    samego konta, flag stanu wiadomości i istniejących etykiet. Folder docelowy
    nie może być korzeniem, folderem wirtualnym, Koszem, Spamem ani ich
    potomkiem i musi przyjmować wiadomości.
20. Przed każdą mutacją filtra wykonywana jest trwała kopia źródłowego pliku
    oraz wpis `prepared` do prywatnego dziennika. Po udanym zapisie dochodzi
    wpis `committed`. Kopie i audyt są przechowywane poza katalogiem
    tymczasowym w katalogu aplikacji użytkownika, z trybami `0700`/`0600`,
    limitem 20 kopii i 5 MiB na plik.
21. Kalendarze, zadania, opróżnianie Kosza/Spamu i kasowanie kontaktów nie
    należą do białej listy.
22. `createFolder` czeka na natywne zdarzenie zakończenia operacji i nie zwraca
    sukcesu bez niepustego URI, ponownego rozwiązania folderu oraz — dla IMAP —
    potwierdzenia `verifiedAsOnlineFolder`. Timeout daje stan `unconfirmed`,
    więc nie może zostać użyty jako cel reguły. Dla IMAP używa operacji
    create-or-subscribe: istniejący, lecz niesubskrybowany folder zostaje
    ujawniony zamiast wejścia w pętlę błędów `FolderCreateFailed`. Operacja
    dostaje kontekst aktywnego okna poczty, aby uwierzytelnienie dostawcy IMAP
    mogło zakończyć callback. Listener implementuje wymagane przez
    `nsIUrlListener` metody `OnStartRunningUrl` i `OnStopRunningUrl`, dlatego
    odrzucenie przez serwer jest zwracane od razu zamiast zamieniać się w
    timeout. Filtry IMAP ponownie sprawdzają potwierdzenie online przed zapisem
    definicji.

## Jawnie poza zakresem

- ochrona przed złośliwym procesem uruchomionym jako ten sam użytkownik;
- szyfrowanie profilu Thunderbirda na dysku;
- polityka retencji lub trenowania po stronie dostawcy modelu;
- gwarancja, że zwykły odczyt IMAP nie zmieni lokalnego cache/indeksu;
- audyt wszystkich wywołań w odpornym na modyfikację dzienniku; istniejące
  dzienniki obejmują automatyczną wysyłkę i mutacje filtrów, ale mogą zostać
  zmienione przez proces działający jako ten sam użytkownik;
- formalna weryfikacja kodu lub niezależny audyt zewnętrzny.

## Kryteria akceptacji pilota

- cały zestaw testów Node kończy się kodem `0`;
- lint nie zgłasza błędów;
- build XPI kończy się kodem `0`;
- dwa kolejne buildy niezmienionych źródeł dają bajtowo identyczne XPI;
- zawartość XPI nie ma `update_url`, nadmiarowych uprawnień ani starej strony
  opcji;
- krytyczne pliki `manifest.json`, `mcp_server/api.js` i
  `mcp_server/schema.json` w XPI są bajtowo zgodne z audytowanym źródłem;
- test na osobnym profilu Thunderbirda pokazuje brak dostępnych kont i
  kontaktów przed wyborem konta oraz książki adresowej;
- dwa profile mają różne identyfikatory i różne pliki połączenia, a mostek
  przypięty do jednego pliku nie przełącza się na drugi;
- `sendMail`, odpowiedź i przekazanie otwierają okno podglądu;
- przy wyłączonej polityce `sendMailDirect` nie występuje w `tools/list`;
- błędna polityka, niedozwolone konto, odbiorca wykluczony przez skonfigurowane
  ograniczenia, przekroczony limit albo niedostępny dziennik blokują
  `sendMailDirect` przed transportem;
- `deleteMessages` i `deleteFolder` przenoszą wyłącznie do Kosza, a próba
  działania wewnątrz Kosza jest odrzucana;
- `createFolder` na testowym IMAP zwraca niepusty, zweryfikowany URI dopiero po
  pojawieniu się folderu na serwerze; potrafi odzyskać istniejący,
  niesubskrybowany folder, błąd URL jest obsługiwany przez natywne nazwy metod
  listenera, a błąd i timeout nigdy nie zwracają `success: true`; folder
  najwyższego poziomu można utworzyć przez `accountId`;
- utworzona przez MCP syntetyczna reguła pozostaje wyłączona po restarcie,
  zachowuje rewizję, odrzuca nieaktualną rewizję, może zostać zaktualizowana i
  usunięta, a kopie bezpieczeństwa i audyt pozostają trwałe;
- MCP nie potrafi włączyć ani uruchomić filtra, a próby użycia niedozwolonych
  akcji, innego konta, folderu wirtualnego/Kosza/Spamu lub nieistniejącej
  etykiety są odrzucane przed zapisem;
- `rawSource` jest ucinany lub odrzucany powyżej limitu, zapisane załączniki
  nie przekraczają limitów, a `searchBody`, host-path attachments i nasłuch
  poza localhostem są odrzucane;
- po restarcie token w pliku połączenia jest inny;
- po wymuszonym zakończeniu stary plik połączenia jest odrzucany na podstawie
  nieaktywnego PID-u, a restart Thunderbirda przywraca połączenie przez
  przepisanie tego samego przypiętego pliku;
- dopiero po tych punktach można rozważyć instalację w profilu produkcyjnym.

## Zgłaszanie problemów

Nie wysyłaj do upstreamu przykładów zawierających prawdziwe dane pocztowe,
tokeny ani ścieżki profilu. Reprodukcję przygotuj na syntetycznej wiadomości i
osobnym profilu testowym.
