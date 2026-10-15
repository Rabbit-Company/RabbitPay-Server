# Uvoz iz CSV

Uvozite več stroškov hkrati iz preglednice, na primer ob prehodu na RabbitPay iz drugega programa.

## Pripravite datoteko

1. Na strani **Stroški** pritisnite **Uvozi CSV**.
2. Pritisnite **Prenesi predlogo**, da dobite datoteko s pravimi stolpci.

   ![Okno Uvozi CSV](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/import-csv/dialog.webp)

3. Izpolnite jo z eno vrstico za vsako stopnjo DDV na računu dobavitelja. Shranite jo kot CSV.

| Stolpec                                             | Kaj vpišete                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `supplier`                                          | Kdo je izdal račun. Obvezno.                                                                                                                 |
| `invoice_number`                                    | Številka računa dobavitelja. Obvezno.                                                                                                        |
| `issue_date`                                        | Datum na računu. Obvezno.                                                                                                                    |
| `net_amount`                                        | Znesek brez DDV, na primer `42,00`. Obvezno.                                                                                                 |
| `vat_rate`                                          | Stopnja DDV te vrstice, na primer `22`                                                                                                       |
| `vat_amount`                                        | DDV te vrstice                                                                                                                               |
| `deductible_vat`                                    | Koliko DDV odbijete. Prazno pomeni ves DDV.                                                                                                  |
| `vat_treatment`                                     | Obravnava v evidencah DDV, na primer `domestic`, `eu_services` ali `domestic_reverse_charge`. Prazno pri vrstici z DDV pomeni domačo nabavo. |
| `supplier_tax_number`                               | Davčna številka ali ID za DDV dobavitelja                                                                                                    |
| `supplier_country`                                  | Dvočrkovna oznaka države, na primer `SI`                                                                                                     |
| `category`                                          | Kategorija, na primer `Travel`                                                                                                               |
| `description`                                       | Za kaj je bil strošek                                                                                                                        |
| `currency`                                          | Prazno pomeni valuto projekta                                                                                                                |
| `paid_date`                                         | Dan plačila. Prazno pri neplačanem računu.                                                                                                   |
| `due_date`, `receipt_date`, `expense_date`, `notes` | Neobvezno                                                                                                                                    |

Vrstice z istim dobaviteljem in številko se združijo v en strošek, zato račun z dvema stopnjama DDV zasede dve vrstici. Slovenska imena stolpcev, kot so `Dobavitelj`, `Številka`, `Osnova` in `DDV`, so prav tako prepoznana.

## Preverite in uvozite

1. Pod **Datoteka CSV** izberite datoteko.
2. Preberite rezultat. **Listine, pripravljene za uvoz** našteje vsak strošek, ki bo ustvarjen. Vrstice, ki jih je treba popraviti, so naštete s številko vrstice.

   ![Dva stroška, pripravljena za uvoz](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/import-csv/preview.webp)

3. Popravite vrstice, ki jih okno našteje, znova izberite datoteko in pritisnite **Uvozi**.

Nič se ne uvozi, dokler niso vse vrstice pravilne, zato datoteka nikoli ni uvožena le napol. Številka računa, ki je za istega dobavitelja že zabeležena, je zavrnjena, zato dvakratni uvoz iste datoteke ne ustvari dvojnikov.

![Uvoženi stroški na seznamu](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/import-csv/imported.webp)
