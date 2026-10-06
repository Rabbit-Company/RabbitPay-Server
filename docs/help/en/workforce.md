# Timesheets, tickets and payroll

Log working hours and absences, plan work with tickets and calculate pay, all following Slovenian employment rules.

These parts of a project need a workforce license, which covers 5 people. Larger teams add employee seats.

## Who can do what

Invite people under **Team** and give each one a role.

| Role       | What they can do                                                             |
| ---------- | ---------------------------------------------------------------------------- |
| Employee   | Log their own hours and absences and work on tickets                         |
| Supervisor | Manage everyone's timesheets, absences and tickets and run work hour reports |
| Manager    | Work with tickets, but not with timesheets                                   |

Owners and administrators can do everything a supervisor can. Employee records and pay have their own permissions, so a supervisor sees hours but not salaries.

## Log working time

Open **Timesheet**.

1. Press **+ Add time** on a day and enter the start and the end. Choose regular hours, overtime or a break.
2. Add a note or link the time to a ticket if you want.
3. At the end of the month, press **Submit month**. A supervisor then approves the timesheet or returns it with a reason.

**Fill working days** adds normal hours with a lunch break to every working day in a period that has no time yet. Slovenian public holidays are known and are skipped. An end time earlier than the start time continues into the next day.

Every change to time and absences is kept in the **Change history**, with who made it and why. The employee can read it too.

## Request and approve absences

Open **Timesheet** > **Absences**.

- An employee presses **Request absence**, chooses the type, such as vacation or sick leave, and the dates. An absence can cover whole days or part of a day.
- A supervisor approves or rejects the request and can add a note for the employee.

The vacation balance shows the days for the year, those taken, those approved ahead and those still waiting for approval.

## Run the monthly report

**Timesheet** > **Monthly report** sums the hours, overtime, holidays and absences of each person and can be downloaded as a PDF or CSV.

The gross pay estimate works out pay from those hours with the supplements for overtime, night, Sunday and holiday work and for seniority, plus meal and commute allowances. The supplements are set under **Timesheet** > **Settings**. It is an estimate, not a payslip.

## Work with tickets

**Tickets** are tasks, bug reports, feature requests and support requests. Assign a ticket to one or more people, set its priority and due date, and link it to a customer. View tickets as a list or as a board.

Time logged on a ticket appears in the timesheets. To bill it:

1. Give the ticket an hourly rate, or a fixed price that is billed once whatever the time logged.
2. Press **Invoice ticket**. You can select several tickets of the same customer to combine them on one invoice.
3. Check the draft invoice that is created and issue it.

A customer sees a ticket in the customer portal only after you give them access and mark the ticket as visible to them. See [Customer portal](customer-portal).

## Keep employee records

**Employees** holds the job title, employment type, pay, start date, vacation days and the personal details payroll needs, such as the tax number and bank account. The records are stored encrypted, and only people with permission to see employee records can read them. Deleting a record keeps the timesheets and absences.

## Run payroll

Open **Payroll**.

1. Press **New payroll run**, choose the month and the payment date, and press **Calculate**. RabbitPay works out gross and net pay from the month's timesheets, absences and employee records.
2. Add bonuses, tax-free refunds and deductions per person where needed, and press **Recalculate**.
3. Press **Finalize** when everything is right.

From a finalized run you get a payslip PDF for each employee, the **REK-O for eDavki** file to import and sign in eDavki, and a **Bank payment file** with one salary payment per employee to upload in your online bank.

Tax and contribution rates are kept as **Tax tables** that apply from a given month, so a change in the law is a new table and past runs stay as they were.

Severance pay, non-residents, student work, contractors and REK-O corrections are not handled yet. Check the results with your accountant before you pay.
