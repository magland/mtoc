% Reassigning the same name with different exact shapes splits each
% conflicting write into its own C binding. Each `disp` reads the
% current binding, so the printed sequence matches numbl byte-for-byte.
v = [1 2 3];
disp(v);

v = [10 20];
disp(v);

v = [1 2 3; 4 5 6];
disp(v);
