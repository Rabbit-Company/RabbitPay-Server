# Timesheets, tickets and payroll

These parts of a project need a workforce license, see
[Administration](administration.md#licensing). They are built around Slovenian
employment rules.

## Roles

Two roles exist for the people who log time:

- `employee` logs their own working hours and absences and works on tickets.
- `supervisor` manages everyone's timesheets, absences and tickets and runs the
  work hour reports.

Owners and administrators can do the same. Managers work with tickets but not
timesheets. Employee records and pay need their own permissions, so a supervisor
sees hours but not salaries.

## Timesheets

Each person logs regular hours, overtime and breaks per day. An end time earlier
than the start time continues into the next day. Breaks up to the configured
length count as working time. Fill working days adds normal hours, with a lunch
break, to every working day in a range that has no time yet. Slovenian public
holidays are known and are not treated as working days.

Every change to time and absences is kept in a change history with who made it
and why, and the employee can read it.

## Absences

Absences are vacation, sick leave, work injury, paid leave, unpaid leave,
parental leave or other, for whole days or part of a day. A request waits until
a supervisor approves or rejects it. Vacation balances per year show the days
the person is entitled to, those used, those approved ahead and those still
waiting.

## Reports

The work hour report sums hours, overtime, holidays and absences per person for
any period and can be downloaded as a PDF. The gross pay estimate works out pay
from those hours with the overtime, night, Sunday, holiday and seniority
supplements set in the timesheet rules, plus meal and commuting allowances. It is
an estimate, not a payslip.

## Tickets

Tickets are tasks, bug reports, feature requests and support requests, assigned
to one or more people and optionally linked to a customer. Time logged on a
ticket appears in the timesheets, and a ticket can have its own hourly rate.
Invoice the logged hours creates a draft invoice for the customer, to check
before issuing it.

A customer can see tickets in the [customer portal](customer-portal.md) only
after a project member gives them access and marks the tickets they may see. The
project also chooses which kinds of ticket customers may open themselves.

## Employee records

Employee records hold the job title, employment type, pay, start date, prior
service (for the seniority supplement) and the personal details payroll needs.
They are encrypted on the server and only people allowed to see employee records
can read them. Deleting a record keeps the timesheets and absences.

## Payroll

A payroll run takes a month's timesheets, absences and employee records and works
out gross and net pay for everyone with an employee record. Bonuses, taxable
additions, tax-free refunds and deductions can be added per person, and a run
can be recalculated until it is finalized. The tax and contribution rates are
kept as tables that start from a given month, so a change in the law is a new
table rather than an edit to history.

From a finalized run RabbitPay produces:

- a payslip PDF for each employee,
- the REK-O XML for eDavki, one per kind of payment (salary, holiday allowance or
  performance pay), to import and sign there,
- a SEPA credit transfer file (pain.001) with one salary payment per employee,
  to upload in your online bank.

Not handled yet: severance pay, non-residents, student work and contractors, and
REK-O corrections. Check the results with your accountant before paying.
