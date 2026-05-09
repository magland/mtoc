% Sequential reassignments at script top level whose types can't share
% one C variable. The lowerer splits each conflicting reassign into a
% fresh binding so the program is accepted.
x = 4;
disp(x);

x = [1 2 3];
disp(x);

x = [1 2 3 4];
disp(x);

x = 7.5;
disp(x);
